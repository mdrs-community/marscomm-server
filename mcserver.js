const fs         = require('fs');
const express    = require('express');
const bodyParser = require('body-parser');
const config     = require('./config.json');
const cors       = require('cors');
const { report } = require('process');

const app = express();
const port = 8081
app.use(bodyParser.json());
app.use(cors());

let db = null;
let verbose = false;
let cargs = {};

global.log = function (str) { console.log(str); }
global.logv = function (str) { if (verbose) console.log(str); }
function stringify(obj) { return JSON.stringify(obj, null, 2); }
function isnum(val) { return /^\d+$/.test(val);	}
function isArray (value) { return value && typeof value === 'object' && value.constructor === Array; }
function assert(condition, str) { if (!condition) { log("ERROR: " + str); throw condition; } }

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

function daysBetween(date1, date2) 
{
  // Ensure that date1 and date2 are valid Date objects
  if (!(date1 instanceof Date) || !(date2 instanceof Date)) { throw new Error("Both arguments must be valid Date objects"); }
  const timeDifference = Math.abs(date2 - date1); // Get the time difference in milliseconds
  const millisecondsPerDay = 1000 * 60 * 60 * 24;
  const daysDifference = Math.floor(timeDifference / millisecondsPerDay);
  return daysDifference;
}

const now = new Date();
const refDateStr = now.getFullYear() + "-" + (now.getMonth()+1) + "-" + now.getDate();
log("refDateStr=" + refDateStr);
const refDate = new Date(refDateStr);
function getSolNum(date) 
{
  if (!date) date = new Date(); 
  return Math.floor((date.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24)); 
}

function processArgs()
{
	let str = "";
	for (let i = 0; i < process.argv.length; i++)
		str += process.argv[i] + " ";
	log("Arg dump:\n" + str);

	cargs.help      = argParser.findArg("help");       // print help text and exit

	if (cargs.help)
	{
		log("usage: node mcserver [loadDB]");
		return false;
	}

	cargs.verbose 	= verbose = argParser.findArg("verbose");
	cargs.loadDB    = argParser.findArg("loadDB"); // load DB on startup
	return true;
}

function newArgParser()
{
	var that = { };

	that.findArg = function (arg, alias)
	{
		for (var i = 0; i < process.argv.length; i++)
			if (process.argv[i] === arg || process.argv[i] === alias)
				return true;
		return false;
	}

	that.findArgVal = function (arg, alias)
	{
		for (var i = 0; i < process.argv.length; i++)
			if (process.argv[i] === arg || process.argv[i] === alias)
				return process.argv[i+1];
		return null;
	}

	return that;
}
var   argParser = newArgParser();


/*
const swaggerUI = require(‘swagger-ui-express’);
const swaggerSpec = require(‘./swagger’);
// Serve Swagger documentation
app.use(‘/api-docs’, swaggerUI.serve, swaggerUI.setup(swaggerSpec));
*/

/*
GET ims?sol=<n>,newerThen=<n>
POST ims { user: <lusername>, str: <str> }
POST reports { user: <lusermame>, reportName: <str>, content: <str> }

*/

///////////////////////////////////////////////////////////////////////////////////////////////////
// Model

function commsDelay()   // commsDelay is the 1-way delay in seconds; -1 means track actual Mars delay
{ //TODO: compute actual Mars comm delay here instead of using hardwired 30
  return (config.commsDelay == -1) ? 30 : config.commsDelay;
}

function commsDelayPassed(sentTime)
{
  const now = new Date();
  return (now - sentTime) * 1000 >= commsDelay();
}

function findUserByName(name)
{
  let users = config.users;
  for (let i = 0; i < users.length; i++)
    if (users[i].name === name) return users[i];
  return null;
}


function newReport(name, planet, reportToClone)
{
	var that = { };

  that.type = "Report";
	that.name = name;
  that.planet = planet;
  if (reportToClone)
  { // Reports can be cloned as part of transmission, so the planet field records where it came from 
    that.content     = reportToClone.content;
    that.author      = reportToClone.author;
    that.transmitted = reportToClone.transmitted; // should always be true
    that.xmitTime    = reportToClone.xmitTime;
  }
  else
  {
    that.content = "";
    that.author = "Fast Freddie";
    that.transmitted = false; // "transmitting" means sending the preport from Mars to Earth (or possibly vice versa).  A report can be on the server but not transmitted.
    that.xmitTime = new Date();
  }
  that.filled = function () { return that.content.length > 0; }
  that.received = function () { return that.transmitted && commsDelayPassed(that.xmitTime); }
  that.update = function (content, username)
  {
    log("actually updating Report " + that.name + " for " + username + " with " + content);
    that.content = content;
    that.author = username;
    that.transmitted = false; // new version has not been transmitted yet, by definition
    that.xmitTime = new Date();
  }
  that.updateFrom = function (report)
  { // we do NOT update the name (which should never change) or the planet, as a non-transient Report never leaves its planet 
    that.content     = report.content;
    that.author      = report.author;
    that.transmitted = report.transmitted;
    that.xmitTime    = report.xmitTime;
  }

  that.transmit = function (username) 
  { 
    that.author      = username;
    that.transmitted = true; 
    that.xmitTime = new Date(); 
  }

  return that;
}

function newIM(content, username)
{
	var that = { };

  that.type = "IM";
  that.content = content;
  that.user = username;
  that.planet = findUserByName(username).planet;
  that.xmitTime = new Date();
  that.transmitted = true;

  that.received = function () { return commsDelayPassed(that.xmitTime); }
  
  return that;
}

function newSol(solNum)
{
	var that = { };
  that.ims = [];
  that.reportsEarth = [];
  that.reportsMars = [];
//TODO: split reports into reportsEarth and reportsMars and populate both
  const dailyReports = config.dailyReports;
  that.solNum = solNum;

  function createReports(targetArray, planet)
  {
    for (let i = 0; i < dailyReports.length; i++)
    {
      const report = newReport(dailyReports[i], planet);
      targetArray.push(report);
    }
    const specialReports = config.specialReports;
    for (let i = 0; i < specialReports.length; i++)
    {
      if (specialReports[i].due == solNum)
      {
        const report = newReport(specialReports[i].name, planet);
        targetArray.push(report);
      }
    }
  }
  createReports(that.reportsEarth, "Earth");
  createReports(that.reportsMars, "Mars");

  that.findReportByName = function (name, username, otherPlanet)
  {
    log("finding Report " + name + " for " + username);
    const user = findUserByName(username);
    let reports = (user.planet === "Earth") ? that.reportsEarth : that.reportsMars;
    // if otherPlanet is set, reverse the logic for which planet supplies the report
    if (otherPlanet) reports = (user.planet === "Earth") ? that.reportsMars : that.reportsEarth;
    for (let i = 0; i < reports.length; i++)
      if (reports[i].name === name) return reports[i];
    return null;
  }

  that.postIM = function (content, user)
  {    
    const im = newIM(content, user);
    this.ims.push(im);
    return im;
  }

  that.updateReport = function (name, content, username)
  { // update Report contents on the user's planet   
    const report = that.findReportByName(name, username);
    log("updating THIS report:");
    log(report);
    if (report) report.update(content, username);
    else Log("can't update non-existant report " + name);
  }

  that.transmitReport = function (name, username)
  {
    const report = that.findReportByName(name, username);
    if (report) report.transmit(username);
    else Log("can't transmit non-existant report " + name);
    return report;
  }

  return that;
}

function newDB()
{
	var that = { };

  that.refDate = refDate;
  log(getSolNum());
  //that.startDate = new Date(now.getTime() - (config.startingSolNum * 24 * 60 * 60 * 1000));
  //log("startDate is " + that.startDate.toDateString());

  that.sols = [];
  that.reportsInTransit = [];
  for (let i = 0; i < config.rotationLength; i++)
  {
    const sol = newSol(i);
    that.sols.push(sol);
  }

  for (let i = 0; i < config.users.length; i++)
    config.users[i].token = 0;

  that.login = function (name, word)
  {
    const user = findUserByName(name);
    const ok = user && user.word === word;
    if (!ok) return 0;
    user.token = Math.random();
    user.loginTime = new Date();
    log("here comes the luser " + stringify(user));
    return { token: user.token, planet: user.planet };
  }

  function validate(name, token)
  {
    const user = findUserByName(name);
    if (!user) return false;
    const recent = user.loginTime && (daysBetween(user.loginTime, new Date()) === 0);
    return recent && (token === user.token || token === "Boken");  // Boken tokens, like, RULE.  DOOD.
  }

  that.postIM = function (message, user, token) 
  { 
    if (!validate(user, token)) return null; 
    log("postIM passed validation on Sol " + getSolNum() + ": " + message);
    return that.sols[getSolNum()].postIM(message, user); 
    //return true;
  }

  that.updateReport = function (name, content, user, token) 
  { 
    log("updateReport(" + name + ", " + content + ", " + user + ", " + token + ")");
    if (!validate(user, token)) return false; 
    log("updateReport passed validation");
    const solNum = getSolNum();
    log("updating report on Sol " + solNum);
    that.sols[solNum].updateReport(name, content, user); 
    return true;
  }

  that.reportArrived = function ()
  {
    log("Report FINALLY arrived:");
    const rit = that.reportsInTransit.shift(); // since commsDelay is constant, the next report done is ALWAYS the oldest one in the queue
    log(rit);
    const solNum = getSolNum();  // if report is in transit across midnight, this will get the wrong Sol...but is it worth fixing?
    const report = that.sols[solNum].findReportByName(rit.name, rit.author, true); // get report on target (other) planet
    log("going to update report " + stringify(report));
    report.updateFrom(rit);
    log("report now updated to:");
    log(report);
    if (report.planet === "Earth") pushToEarth(report);
    else                           pushToMars(report);
  }

  that.transmitReport = function (name, user, token) 
  { 
    log("transmitReport(" + name + ", " + user + ", " + token + ")");
    if (!validate(user, token)) return false; 
    const solNum = getSolNum();
    log("transmitting report on Sol " + solNum);
    const report = that.sols[solNum].transmitReport(name, user);
    that.reportsInTransit.push(newReport(name, report.planet, report));
    setTimeout(() => that.reportArrived(), config.commsDelay*1000);
    return report;
  }

  that.save = function ()
  {
    fs.writeFileSync('db.json', JSON.stringify(that));
  }
  that.load = function ()
  {
    let ddb = JSON.parse(fs.readFileSync('db.json'));
    log("Here's what you get, Holmez");
    log(ddb);
    that.sols = ddb.sols;
    that.refDate = ddb.refDate;
    refDate = that.refDate;
  }

  return that;
}



///////////////////////////////////////////////////////////////////////////////////////////////////
// Endpoints


app.get('/', (req, res) => 
{
  res.send('Hello Facture!');
});

app.get('/ref-date', (req, res) => 
{
  res.status(200).json({ refDate: refDate });
});

app.get('/comms-delay', (req, res) => 
{
  res.status(200).json({ commsDelay: commsDelay() });
});

app.get('/sols/:sol', (req, res) => 
{
  const sol = req.params.sol;
  log("getting Sol " + sol);
  log(db.sols[sol]);
  res.status(200).json(db.sols[sol]);
});

app.post('/ims', (req, res) => 
{
  log("POSTer child for ims");
  const { message, username, token } = req.body;
  const im = db.postIM(message, username, token);
  if (im)
  {
    res.status(200).json( { message: 'IM POSTerized' } );
    log("distributing " + stringify(im));
    for (let client of pushClientsEarth) 
    {
      console.log("push to et Earth");
      pushEvent(client, im);
    }
    for (let client of pushClientsMars) 
    {
      console.log("push to et Mars");
      pushEvent(client, im);
    }
  }
  else
    res.status(401).json( { message: 'Bad Luser' } );
});

app.get('/reports', (req, res) => 
{
  log("goGETer them reports");
  let reports = [];
  for (let i = 0; i < config.dailyReports.length; i++)
    reports.push(config.dailyReports[i]);
  for (let i = 0; i < config.specialReports.length; i++)
    reports.push(config.specialReports[i].name);
  res.status(200).json(reports);
});

// The client never actually creates reports -- they preexist in an empty state on the server. 
// The client can update or transmit reports.
app.post('/reports/update', (req, res) => 
{
  log("POSTer child for updated reports");
  log(req.body);
  const { reportName, content, username, token } = req.body;

  if (db.updateReport(reportName, content, username, token))
    //res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8081');
    res.status(200).json({ message:'report POSTiculated'});
  else
    res.status(401).json({ message:'Bad Luser'});
});

app.post('/reports/transmit/:reportName', (req, res) => 
{
  log("transmitting the vir...ummh...report");
  log(req.body);
  const { username, token } = req.body;
  const reportName = req.params.reportName;
  const report = db.transmitReport(reportName, username, token);
  if (report) 
    res.status(200).json({ message:'report transmitted'});
  else
    res.status(401).json({ message:'Bad Luser'});
});

app.post('/login', (req, res) => 
{
  const { username, password } = req.body;

  if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
  }

  const userinfo = db.login(username, password);
  log(userinfo);
  if (userinfo.token)  { return res.status(200).json({ message: 'Login successful', token: userinfo.token, planet: userinfo.planet }); }
  else                 { return res.status(401).json({ message: 'Invalid username or password' }); }
});

let pushClientsMars  = new Set();
let pushClientsEarth = new Set();
function pushEvent(client, obj) 
{ 
  const str = 'data: ' + JSON.stringify(obj) + '\n\n';
  log("pushet to et: " + str);
  client.write(str); 
}
function pushToEarth(obj)
{
  log("pushing et to " + pushClientsEarth.size + " Earth clients");
  for (let client of pushClientsEarth) 
  {
    console.log("push to et Earth");
    pushEvent(client, obj);
  }
}
function pushToMars(obj)
{
  log("pushing et to " + pushClientsMars.size + " Mars clients");
  for (let client of pushClientsMars) 
  {
    console.log("push to et Mars");
    pushEvent(client, obj);
  }
}

app.get('/events/:planet', (req, res) => 
{
  const planet = req.params.planet;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (planet === "Earth") pushClientsEarth.add(res);
  else                    pushClientsMars.add(res);
  log("one more PushClient...now have " + pushClientsEarth.size + " for Earth, and " + pushClientsMars.size + " for Mars");
  //const sendEvent = () => {
  //  const str = `data: ${JSON.stringify({ message: "Hello, World!" })}\n\n`;
  //  log("sendet to et: " + str);
  //  res.write(str);
  //};

  // Send an initial event immediately
  //sendEvent();
  pushEvent(res, { message: "Hello Facture!"} );

  // Send subsequent events every 30 seconds
  //const intervalId = setInterval(sendEvent, 30000);

  // Handle client disconnect
  req.on('close', () => 
  {
    //clearInterval(intervalId);
    if (planet === "Earth") pushClientsEarth.delete(res);
    else                    pushClientsMars.delete(res);
    log("one less PushClient...now have " + pushClientsEarth.size + " for Earth, and " + pushClientsMars.size + " for Mars");
    res.end();
  });
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// main

function main()
{
  log("MarsComm open for bidness\n" +
      "=========================");
  log(config);
  processArgs();
  db = newDB();
  log(db);
  if (cargs.loadDB) db.load();

/*
  db.updateReport("Journalist", "badass journalist content");
  db.save();
  db.sols = [];
  db.load();
*/
  log(db);
  log(db.sols[0]);
}

main();
app.listen(port, () => 
{
  console.log(`MECA listening on port ${port}`);
});
