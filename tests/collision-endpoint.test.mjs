import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const seg = html.slice(html.indexOf('function getSegDist('), html.indexOf('\nconst _batchM'));
const start = html.indexOf('  resolveWallCollisions(');
const method = html.slice(start, html.indexOf('\n  // Sectors bucketed', start));
const resolve = vm.runInNewContext(`const _segHit = {}; ${seg}; ({${method}}).resolveWallCollisions`);
function mover(wall) { return {wallsNear: () => [wall], resolveWallCollisions: resolve}; }
test('wall endpoint permits rounding a convex corner without entering its radius', () => {
  for (const reverse of [false,true]) {
    const a={x:20,z:4}, b={x:20,z:24};
    const e=mover({solid:true,p1:reverse?b:a,p2:reverse?a:b});
    let p={x:21,z:4.1};
    for(let i=0;i<40;i++) p=e.resolveWallCollisions(p.x-.04,p.z-.04,1,0,1.6,p.x,p.z);
    assert.ok(p.x<20 && p.z<3,JSON.stringify(p));
    assert.ok(Math.hypot(p.x-20,p.z-4)>=1);
  }
});
test('wall interior still rejects a step through the solid segment', () => {
  const e=mover({solid:true,p1:{x:20,z:4},p2:{x:20,z:24}});
  const p=e.resolveWallCollisions(19.9,10,1,0,1.6,21,10);
  assert.ok(p.x>=21-1e-6);
});
