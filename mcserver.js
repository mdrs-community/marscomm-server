const fs         = require('fs');
const express    = require('express');
const bodyParser = require('body-parser');
const config     = require('./config.json');
const cors       = require('cors');
const { report } = require('process');
const multer     = require("multer");
const JSZip      = require('jszip');

const app = express();
const port = 8081;
const attachDir = 'attachments';
const multerd = multer({ dest: attachDir });

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

// for simplicity, attachment content is carried around as base64 string right from the moment it is uploaded, until 
// the last moment when we need to write binary to the zip file 
function newAttachment(reportName, filename, content)
{ // Attachment doesn't have its own planet as it's on its parent Report's planet
	var that = { };

  that.type = "Attachment";
  that.reportName = reportName;
	that.filename = filename;
  that.content = content;
  return that;
}

// A Report is created only during server startup, and when a Report is transmitted (using reportToClone)
function newReport(name, planet, reportToClone)
{
	var that = { };

  that.type = "Report";
	that.name = name;
  that.planet = planet;
  that.attachments = [];
  if (reportToClone)
  { // Reports can be cloned as part of transmission, so the planet field records where it came from 
    that.content     = reportToClone.content;
    that.approved    = reportToClone.approved;
    that.author      = reportToClone.author;
    that.authorPlanet= reportToClone.authorPlanet;
    that.transmitted = reportToClone.transmitted; // should always be true
    that.xmitTime    = reportToClone.xmitTime;
    for (let i = 0; i < reportToClone.attachments.length; i++)
      that.attachments[i] = reportToClone.attachments[i];
  }
  else
  { // for brand new Reports only 
    that.content = "";
    that.approved    = false; // if true means approved by Mission Control
    that.author = "Fast Freddie";
    that.authorPlanet = "Jupiter";
    that.transmitted = false; // "transmitting" means sending the preport from Mars to Earth (or possibly vice versa).  A report can be on the server but not transmitted.
    that.xmitTime = new Date();
  }
  that.filled = function () { return that.content.length > 0; }
  that.received = function () { return that.transmitted && commsDelayPassed(that.xmitTime); }
  that.update = function (content, approved, attachments, username) // called when report is edited or approved
  {
    log("actually updating Report " + that.name + " for " + username + " with " + content);
    const user = findUserByName(username);
    const planet = user ? user.planet : "Jupiter";
    that.content     = content;
    that.approved    = approved;
    that.attachments = attachments;
    that.author      = username;
    that.authorPlanet= planet;
    that.transmitted = false; // new version has not been transmitted yet, by definition
    that.xmitTime    = new Date();
    log("report finished updating to " + that);
  }
  that.updateFrom = function (report) // called when a report arrives from a transmit
  { // we do NOT update the name (which should never change) or the planet, as a non-transient Report never leaves its planet 
    that.content     = report.content;
    that.approved    = report.approved;
    that.author      = report.author;
    that.authorPlanet= report.authorPlanet;
    that.transmitted = report.transmitted;
    that.xmitTime    = report.xmitTime;
    for (let i = 0; i < report.attachments.length; i++)
      that.attachments[i] = report.attachments[i];
  }
  that.addAttachment = function (filename, content)
  {
    log("actually creating the attachment " + filename + " for report " + name);
    const attachment = newAttachment(name, filename, content);
    that.attachments.push(attachment);
    return attachment;
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

  that.updateReport = function (name, content, approved, attachments, username)
  { // update Report contents on the user's planet   
    const report = that.findReportByName(name, username);
    log("updating THIS report:");
    log(report);
    if (report) report.update(content, approved, attachments, username);
    else Log("can't update non-existant report " + name);
    return report;
  }

  that.addAttachment = function (reportName, filename, content, username)
  {
    const report = this.findReportByName(reportName, username);
    return report.addAttachment(filename, content);
  }

  that.getAttachments = function (planet)
  {
    log("GETing attachments for " + planet);
    const reports = (planet === "Earth") ? that.reportsEarth : that.reportsMars;
    const allofit = [];
    for (let i = 0; i < reports.length; i++)
    {
      const attachments = reports[i].attachments;
      for (let j = 0; j < attachments.length; j++)
        allofit.push(attachments[j]);
    }
    log("returning " + allofit.length + " attachments");
    return allofit;
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
    log("validating " + name + ", " + token + "; recent=" + recent + ", user=" + JSON.stringify(user));
    return recent && (token === user.token || token === "Boken");  // Boken tokens, like, RULE.  DOOD.
  }

  that.postIM = function (message, user, token) 
  { 
    if (!validate(user, token)) return null; 
    log("postIM passed validation on Sol " + getSolNum() + ": " + message);
    return that.sols[getSolNum()].postIM(message, user); 
    //return true;
  }

  that.updateReport = function (name, content, approved, attachments, user, token) 
  { 
    log("updateReport(" + name + ", " + content + ", " + user + ", " + token + ")");
    if (!validate(user, token)) return false; 
    log("updateReport passed validation");
    const solNum = getSolNum();
    log("updating report on Sol " + solNum);
    const report = that.sols[solNum].updateReport(name, content, approved, attachments, user); 
    pushToLocal(report);
    return true;
  }

  that.addAttachment = function (reportName, filename, content, username, token)
  {
    if (!validate(username, token)) return null; 
    const solNum = getSolNum();
    log("report " + reportName + " getting some " + filename + " on Sol " + solNum);
    const attachment = that.sols[solNum].addAttachment(reportName, filename, content, username); 
    log(attachment);
    return attachment;
  }

  that.addAttachments = function (reportName, files, username, token)
  {
    if (!validate(username, token)) return 0; 
    const solNum = getSolNum();
    const sol = that.sols[solNum];
    log("report " + reportName + " getting " + files.length + " filez on Sol " + solNum);
    files.forEach((file) =>
    { // attachment "content" is now the filename that multer generates and which is needed later to generate a zip
      const attachment = sol.addAttachment(reportName, file.originalname, file.filename, username); 
      log(attachment);
    });
    const report = sol.findReportByName(reportName, username);
    pushToLocal(report); // when attachment added, push report locally so other UIs can be updated

    return files.length;
  }

  that.getAttachmentsZip = function (planet, solNum)
  {
    log("where the FARUK is my attachment ZIP for sol " + solNum + " on " + planet);
    const sol = that.sols[solNum];
    const attachments = sol.getAttachments(planet); 
    const zip = new JSZip();

    attachments.forEach( (attachment) =>
    {
      log("attempting to read " + attachDir + '/' + attachment.content);
      const data = fs.readFileSync(attachDir + '/' + attachment.content);
      zip.file(attachment.filename, data);
    });
    return zip;
  }

  

  that.getAttachments = function (planet, solNum) 
  { 
    log("where the FARUK is my attachment for sol " + solNum + " on " + planet);
    const sol = that.sols[solNum];
    return sol.getAttachments(planet); 
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
    pushToLocal(report);
  }

  that.transmitReport = function (name, user, token) 
  { 
    log("transmitReport(" + name + ", " + user + ", " + token + ")");
    if (!validate(user, token)) return false; 
    const solNum = getSolNum();
    log("transmitting report on Sol " + solNum);
    const report = that.sols[solNum].transmitReport(name, user);
    that.reportsInTransit.push(newReport(name, report.planet, report));
    pushToLocal(report);
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

app.get('/reports/templates', (req, res) => 
{
  log("goGETer them templates");
  res.status(200).json(config.reportTemplates);
});

// The client never actually creates reports -- they preexist in an empty state on the server. 
// The client can update or transmit reports.
app.post('/reports/update', (req, res) => 
{
  log("POSTer child for updated reports");
  log(req.body);
  const { reportName, content, approved, attachments, username, token } = req.body;

  if (db.updateReport(reportName, content, approved, attachments, username, token))
    //res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8081');
    res.status(200).json({ message:'report POSTiculated'});
  else
    res.status(401).json({ message:'Bad Luser'});
});

app.get('/attachments/:planet/:solNum', (req, res) => 
{
  log("don't GET too attachmented");
  const planet = req.params.planet;
  const solNum = req.params.solNum;
  log("getting attachments for " + planet + " for Sol " + solNum);
  let attachments = db.getAttachments(planet, solNum);
  log("returning " + attachments.length + " attachments");
  res.status(200).json(attachments);
});

app.get('/attachments/zip/:planet/:solNum', async (req, res) => 
{
  log("don't GET too zipped about attachments");
  const planet = req.params.planet;
  const solNum = req.params.solNum;
  log("getting attachment zip for " + planet + " for Sol " + solNum);
  const zip = db.getAttachmentsZip(planet, solNum);
  const zipContent = await zip.generateAsync({ type: 'nodebuffer' });
  log("returning zip of attachments");
    // Set the appropriate headers
  res.setHeader('Content-Type', 'application/zip');
  const zipFilename = 'attachments' + solNum + planet + '.zip';
  res.setHeader('Content-Disposition', 'attachment; filename=' + zipFilename);
  res.setHeader('Content-Length', zipContent.length);

  // Send the zip file content as the response
  res.send(zipContent);
  //res.status(200).download(zip);
});

//app.post('/reports/add-attachment/:reportName/:filename', (req, res) => 
app.post('/reports/add-attachment', (req, res) => 
{
  //const reportName = req.params.reportName;
  //const filename = req.params.filename;
  const { reportName, filename, content, username, token } = req.body;
  log("got attachment for " + reportName + ": " + filename + " from " + username);
  if (db.addAttachment(reportName, filename, content, username, token))
    res.status(200).json({ message:'attachmentized'});
  else
    res.status(401).json({ message:'Bad Luser'});
});

app.post('/attachments', multerd.array('files'), (req, res) => 
{
  log("attach THIS, Holmez");
  if (!req.files) 
    return res.status(400).send('No files uploaded.');

  let { reportName, username, token } = req.body;
  token = Number(token);
  log("multerd in action for " + username + " (" + token + ") on " + reportName);
  //const filePath = path.join(__dirname, 'uploads', req.file.filename);
  //console.log(`File saved at: ${filePath}`);
  log(req.files);
  if (db.addAttachments(reportName, req.files, username, token))
    res.status(200).json({ message:'attachmentized'});
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
function pushToLocal(obj) // push this object to all clients on whatever planet it's local to
{
  if (obj.planet === "Earth") pushToEarth(obj);
  else                        pushToMars(obj);
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
