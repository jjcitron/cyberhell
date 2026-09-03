/* Pulls the MAP01_DATA literal out of index.html so tests can read the same
   level the browser runs, with no duplicated copy to drift out of sync. */
const fs = require('fs');
const path = require('path');

function loadMap01(htmlPath) {
  const src = fs.readFileSync(htmlPath || path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = src.indexOf('const MAP01_DATA = {');
  if (start === -1) throw new Error('MAP01_DATA not found in index.html');
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('MAP01_DATA literal is unbalanced');
  // The literal contains Math.PI, so evaluate rather than JSON.parse.
  return eval('(' + src.slice(open, end + 1) + ')');
}

module.exports = { loadMap01 };
