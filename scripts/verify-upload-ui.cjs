const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.ts'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.ts'), 'utf8');
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

check('upload joins the existing rail navigation',
  /\['upload', '上传', 'upload'\]/.test(app) && !/upload-nav-button/.test(app) && !/upload-nav-button/.test(css));
check('native picker starts the upload selection flow',
  /api\.upload\.pickFiles\(\)/.test(app) && /state\.upload\.selectedFiles/.test(app));
check('drop handlers collect opaque file grants without new styling',
  /dragover/.test(app) && /api\.upload\.grantDroppedFile\(/.test(app) && !/app-drop-active|drop-active/.test(css));
check('upload page reuses existing component classes only',
  /renderUpload\(\)/.test(app) &&
  !/class="[^"]*(?:upload-|capability-grid|oauth-)[^"]*"/.test(app));
check('drop selection does not directly start an upload',
  /function handleDroppedFiles[\s\S]*?\n}/.exec(app)?.[0].includes('api.upload.add') === false && /state\.upload\.confirm = valid\.length > 0/.test(app));
check('confirmation gates the upload IPC call',
  /data-upload-confirm/.test(app) && /api\.upload\.add\(/.test(app));
check('unsupported providers are explicitly unavailable',
  /暂无可核验的官方上传接口/.test(app));
check('upload task view renders progress and errors',
  /upload\.tasks/.test(app) && /uploadedBytes/.test(app) && /t\.error/.test(app));
check('renderer stylesheet gains no upload-specific rules',
  !/\.upload-|\.capability-grid|\.oauth-|app-drop-active|drop-active/.test(css));
check('dropped paths are converted into grants in preload',
  /grantDroppedFile: \(file: Parameters<typeof webUtils\.getPathForFile>\[0\]\) =>\s*ipcRenderer\.invoke\('upload:grantDroppedFile', webUtils\.getPathForFile\(file\)\)/.test(preload));
check('main upload IPC consumes only opaque grant tokens',
  /fileToken\?: unknown/.test(main.slice(main.indexOf("ipcMain.handle('upload:add'"), main.indexOf("ipcMain.handle('upload:cancel'"))) &&
  /createFromGrants\(normalized/.test(main));

const failed = results.filter((result) => !result.ok);
console.log(`SUMMARY ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
