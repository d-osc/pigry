const fs = require('fs');
const pigry = 'C:' + '\\Users\\ondev\\Projects\\pigry';
const graph = 'C:' + '\\Users\\ondev\\AppData\\Local\\Temp\\pigry-graph-test';
const config = { recent: [pigry, graph], active: pigry };
const target = process.env.APPDATA + '\\com.pigry.app\\config.json';
fs.writeFileSync(target, JSON.stringify(config, null, 2));
// Read back and assert — no silent failures.
const readBack = JSON.parse(fs.readFileSync(target, 'utf8'));
if (readBack.active !== pigry) throw new Error('config write failed');
console.log('verified active =', readBack.active);
