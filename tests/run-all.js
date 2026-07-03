// Esegue tutti i test in sequenza: node tests/run-all.js
const { execFileSync } = require('child_process');
const path = require('path');
const suites = ['test.js', 'tap.js', 'sidebar.js', 'export.js', 'shapes.js', 'images.js', 'scale.js', 'misc.js', 'blit.js', 'fit.js'];
let failed = 0;
for (const s of suites) {
  process.stdout.write(`\n=== ${s} ===\n`);
  try {
    execFileSync('node', [path.join(__dirname, s)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}
console.log(failed ? `\n${failed} suite FALLITE` : '\nTutte le suite passano ✔');
process.exit(failed ? 1 : 0);
