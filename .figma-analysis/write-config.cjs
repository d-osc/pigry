const fs = require('fs');
const orbit = 'C:' + '\\Users\\ondev\\Projects\\orbit';
const graph = 'C:' + '\\Users\\ondev\\AppData\\Local\\Temp\\orbit-graph-test';
const config = { recent: [orbit, graph], active: orbit };
const target = process.env.APPDATA + '\\com.orbit.app\\config.json';
fs.writeFileSync(target, JSON.stringify(config, null, 2));
// Read back and assert — no silent failures.
const readBack = JSON.parse(fs.readFileSync(target, 'utf8'));
if (readBack.active !== orbit) throw new Error('config write failed');
console.log('verified active =', readBack.active);
