/* MarsComm file-sharing routes
   Registered into the Express app by calling module.exports.register(app, config, pushAll, validate, commsDelaySec).
   Files are stored in the 'files/' directory by multer.
   Call getFiles()/setFiles() to integrate with DB save/load. */

const fs     = require('fs');
const multer = require('multer');

const filesDir = 'files';
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir);
const multerd = multer({ dest: filesDir });

let files  = [];
let nextId = 1;
let commsDelaySec = () => 0; // supplied by mcserver via register(); returns the one-way delay in seconds

function rehydrateFile(f)
{
  const r = Object.assign({}, f);
  r.xmitTime = new Date(f.xmitTime);
  if (r.prevOp) r.prevOp = Object.assign({}, r.prevOp, { xmitTime: new Date(r.prevOp.xmitTime) });
  return r;
}

function getCommsDelayMs() { return commsDelaySec() * 1000; }

function getUserPlanet(config, username)
{
  const u = (config.users || []).find(u => u.name === username);
  return u ? u.planet : 'Earth';
}

function clearExpiredPrevOps()
{
  const delay = getCommsDelayMs();
  const now   = Date.now();
  for (const f of files)
    if (f.prevOp && (now - f.prevOp.xmitTime.getTime()) > delay)
      delete f.prevOp;
}

function visibleFiles()
{
  clearExpiredPrevOps();
  const delay = getCommsDelayMs();
  const now   = Date.now();
  // Include deleted files while their prevOp is still in transit (other planet hasn't seen the delete yet)
  return files.filter(f => !f.deleted ||
    (f.prevOp && f.prevOp.op === 'delete' && (now - f.prevOp.xmitTime.getTime()) <= delay));
}

module.exports = {
  getFiles() { return files; },

  setFiles(arr)
  {
    files  = arr.map(rehydrateFile);
    nextId = files.length ? Math.max(...files.map(f => f.id)) + 1 : 1;
  },

  register(app, config, pushAll, validate, commsDelayFn)
  {
    if (commsDelayFn) commsDelaySec = commsDelayFn;
    app.get('/files/folders', (req, res) =>
    {
      res.status(200).json((config.fileSystem && config.fileSystem.folders) || []);
    });

    app.get('/files', (req, res) =>
    {
      res.status(200).json(visibleFiles());
    });

    app.post('/files/upload', multerd.array('files'), (req, res) =>
    {
      let { folder, username, token } = req.body;
      token = Number(token);
      if (!validate(username, token)) return res.status(401).json({ message: 'Bad user' });
      if (!req.files || !req.files.length) return res.status(400).json({ message: 'No files' });
      const planet = getUserPlanet(config, username);
      req.files.forEach(f =>
      {
        const rec = { id: nextId++, name: f.originalname, folder, size: f.size,
                      storedAs: f.filename, uploadedBy: username, planet,
                      xmitTime: new Date(), deleted: false };
        files.push(rec);
        pushAll({ type: 'FileUpdate', op: 'add', file: rec });
      });
      res.status(200).json({ message: 'uploaded' });
    });

    app.post('/files/rename', (req, res) =>
    {
      let { id, name, username, token } = req.body;
      token = Number(token);
      if (!validate(username, token)) return res.status(401).json({ message: 'Bad user' });
      const f = files.find(f => f.id === Number(id) && !f.deleted);
      if (!f) return res.status(404).json({ message: 'Not found' });
      f.prevOp = { op: 'rename', planet: getUserPlanet(config, username), xmitTime: new Date(), prevName: f.name };
      f.name = name;
      pushAll({ type: 'FileUpdate', op: 'rename', file: f });
      res.status(200).json({ message: 'renamed' });
    });

    app.post('/files/move', (req, res) =>
    {
      let { id, folder, username, token } = req.body;
      token = Number(token);
      if (!validate(username, token)) return res.status(401).json({ message: 'Bad user' });
      const f = files.find(f => f.id === Number(id) && !f.deleted);
      if (!f) return res.status(404).json({ message: 'Not found' });
      f.prevOp = { op: 'move', planet: getUserPlanet(config, username), xmitTime: new Date(), prevFolder: f.folder };
      f.folder = folder;
      pushAll({ type: 'FileUpdate', op: 'move', file: f });
      res.status(200).json({ message: 'moved' });
    });

    app.post('/files/delete', (req, res) =>
    {
      let { id, username, token } = req.body;
      token = Number(token);
      if (!validate(username, token)) return res.status(401).json({ message: 'Bad user' });
      const f = files.find(f => f.id === Number(id) && !f.deleted);
      if (!f) return res.status(404).json({ message: 'Not found' });
      f.prevOp = { op: 'delete', planet: getUserPlanet(config, username), xmitTime: new Date() };
      f.deleted = true;
      pushAll({ type: 'FileUpdate', op: 'delete', file: f });
      res.status(200).json({ message: 'deleted' });
    });

    app.get('/files/download', (req, res) =>
    {
      const id = Number(req.query.id);
      const f  = files.find(f => f.id === id && !f.deleted);
      if (!f) return res.status(404).send('Not found');
      const filePath = filesDir + '/' + f.storedAs;
      if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk');
      res.setHeader('Content-Disposition', 'attachment; filename="' + f.name + '"');
      fs.createReadStream(filePath).pipe(res);
    });
  }
};
