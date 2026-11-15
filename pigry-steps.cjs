// Lists the steps of the windows job in run 43713654689.
const fs = require('fs');
var exec = require('child_process').execSync;
var out = exec('gh api repos/d-osc/pigry/actions/runs/43713654689/jobs', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
var data = JSON.parse(out);
var job = data.jobs.find(function (j) { return j.name === 'build (windows-latest)'; });
if (!job) { console.log('windows job not found'); process.exit(1); }
console.log('job id:', job.id, '| status:', job.status, '| conclusion:', job.conclusion);
job.steps.forEach(function (st) {
  console.log(st.number + '. ' + st.name + ' → ' + st.status + '/' + st.conclusion);
});
