const fs = require('fs');
const express = require('express');
const app = express();
const port = 8081

const config = require('./config.json');
let db = null;

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

function commsDelayPassed(sentTime)
{
  const now = new Date();
  // commsDelay is the 1-way delay in seconds; -1 means track actual Mars delay
  if (config.commsDelay == -1) return 30; //TODO: compute actual Mars comm delay here
  return (now - sentTime) * 1000 >= config.commsDelay;
}

function newReport(name)
{
	var that = { };

	that.name = name;
  that.content = "";
  that.time = new Date();

  that.filled = function () { return that.content.length > 0; }
  that.received = function () { return commsDelayPassed(that.time); }
  that.update = function (content, by)
  {
    that.content = content;
    that.author = by;
    that.time = new Date();
  }

  return that;
}

function newIM(content)
{
	var that = { };

  that.content = "";
  that.time = new Date();

  that.received = function () { return commsDelayPassed(that.time); }
  
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

  that.postIM = function (message)
  {    
    const im = newIM(message);
    this.ims.push(im);
  }

  that.updateReport = function (name, content, by)
  {    
    const report = findReportByName(name);
    if (report) report.update(content, by);
    else Log("can't update non-existant report " + name);
  }

  return that;
}

function newDB()
{
	var that = { };
  const startDate = new Date();

  function getSol()
  {
    const now = new Date();
    return daysBetween(startDate, now);
  }

  that.sols = [];
  for (let i = 0; i < config.rotationLength; i++)
  {
    const sol = newSol(i);
    that.sols.push(sol);
  }

  that.postIM = function (message) { that.sols[getSol()].postIM(message); }
  that.updateReport = function (name, content, by) 
  { 
    const sol = getSol();
    log("updating report on Sol " + sol);
    that.sols[sol].updateReport(name, content, by); 
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
  }

  return that;
}



///////////////////////////////////////////////////////////////////////////////////////////////////
// Endpoints


app.get('/', (req, res) => 
{
  res.send('Hello Facture!');
});

app.post('/ims', (req, res) => 
{
  db.postIM(req.body);
  res.send('IM POSTed');
});

app.post('/reports', (req, res) => 
{
  db.postReport(req.body);
  res.send('report POSTed');
});


///////////////////////////////////////////////////////////////////////////////////////////////////
// main

function main()
{
  log("MarsComm open for bidness\n" +
      "=========================");
  log(config);
  db = newDB();
  log(db);
  db.updateReport("Journalist", "badass journalist content");
  db.save();
  db.sols = [];
  db.load();
  log(db);
  log(db.sols[0]);
}

main();
app.listen(port, () => 
{
  console.log(`MECA listening on port ${port}`);
});
