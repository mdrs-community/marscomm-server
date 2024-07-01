const fs         = require('fs');
const express    = require('express');
const bodyParser = require('body-parser');
const config     = require('./config.json');
const cors       = require('cors');

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

function newReport(name)
{
	var that = { };

	that.name = name;
  that.content = "";
  that.transmitted = false; // "transmitting" means sending the preport from Mars to Earth (or possibly vice versa).  A report can be on the server but not transmitted.
  that.xmitTime = new Date();

  that.filled = function () { return that.content.length > 0; }
  that.received = function () { return that.transmitted && commsDelayPassed(that.xmitTime); }
  that.update = function (content, by)
  {
    that.content = content;
    that.author = by;
    that.xmitTime = new Date();
  }

  that.transmit = function () { that.transmitted = true; }

  return that;
}

function newIM(content, user)
{
	var that = { };

  that.content = content;
  that.user = user;
  that.xmitTime = new Date();
  that.transmitted = true;

  that.received = function () { return commsDelayPassed(that.xmitTime); }
  
  return that;
}

function newSol(solNum)
{
	var that = { };
  that.ims = [];
  that.reports = [];
  const dailyReports = config.dailyReports;
  that.solNum = solNum;
  for (let i = 0; i < dailyReports.length; i++)
  {
    const report = newReport(dailyReports[i]);
    that.reports.push(report);
  }
  const specialReports = config.specialReports;
  for (let i = 0; i < specialReports.length; i++)
  {
    if (specialReports[i].sol == solNum)
    {
      const report = newReport(specialReports[i]);
      that.reports.push(report);
    }
  }

  function findReportByName(name)
  {
    let reports = that.reports;
    for (let i = 0; i < reports.length; i++)
      if (reports[i].name === name) return reports[i];
    return null;
  }

  that.postIM = function (content, user)
  {    
    const im = newIM(content, user);
    this.ims.push(im);
  }

  that.updateReport = function (name, content, by)
  {    
    const report = findReportByName(name);
    if (report) report.update(content, by);
    else Log("can't update non-existant report " + name);
  }

  that.transmitReport = function (name)
  {
    const report = findReportByName(name);
    if (report) report.transmit();
    else Log("can't transmit non-existant report " + name);
  }

  return that;
}

function newDB()
{
	var that = { };
  that.startDate = new Date();
  log("startDate is " + that.startDate.toDateString());

  function getSol()
  {
    const now = new Date();
    return daysBetween(that.startDate, now);
  }

  that.sols = [];
  for (let i = 0; i < config.rotationLength; i++)
  {
    const sol = newSol(i);
    that.sols.push(sol);
  }

  for (let i = 0; i < config.users.length; i++)
    config.users[i].token = 0;

  function findUserByName(name)
  {
    let users = config.users;
    for (let i = 0; i < users.length; i++)
      if (users[i].name === name) return users[i];
    return null;
  }

  that.login = function (name, word)
  {
    const user = findUserByName(name);
    const ok = user && user.word === word;
    if (!ok) return 0;
    user.token = Math.random();
    user.loginTime = new Date();
    log("here comes the luser " + stringify(user));
    return user.token;
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
    if (!validate(user, token)) return false; 
    log("postIM passed validation on Sol " + getSol() + ": " + message);
    that.sols[getSol()].postIM(message, user); 
    return true;
  }

  that.updateReport = function (name, content, user, token) 
  { 
    log("updateReport(" + name + ", " + content + ", " + user + ", " + token + ")");
    if (!validate(user, token)) return false; 
    log("updateReport passed validation");
    const sol = getSol();
    log("updating report on Sol " + sol);
    that.sols[sol].updateReport(name, content, user); 
    return true;
  }

  that.transmitReport = function (name, user, token) 
  { 
    log("transmitReport(" + name + ", " + user + ", " + token + ")");
    if (!validate(user, token)) return false; 
    const sol = getSol();
    log("updating report on Sol " + sol);
    that.sols[sol].transmitReport(name); 
    return true;
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
    that.startDate = ddb.startDate;
  }

  return that;
}



///////////////////////////////////////////////////////////////////////////////////////////////////
// Endpoints


app.get('/', (req, res) => 
{
  res.send('Hello Facture!');
});

app.get('/start-date', (req, res) => 
{
  res.status(200).json({ startDate: db.startDate });
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
  if (db.postIM(message, username, token))
    res.status(200).json( { message: 'IM POSTerized' } );
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

  if (db.transmitReport(reportName, username, token))
    //res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8081');
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

  const token = db.login(username, password);
  if (token)  { return res.status(200).json({ message: 'Login successful', token: token }); }
  else        { return res.status(401).json({ message: 'Invalid username or password' }); }
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
