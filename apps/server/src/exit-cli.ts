// pnpm m1:exit [runs] [concurrency] [tickMs]
import { runExit } from './exit-run.ts';

const [runs = 1000, concurrency = 64, tickMs = 1] = process.argv.slice(2).map(Number);
const s = await runExit({ runs, concurrency, tickMs });
console.log(JSON.stringify({ ...s, botErrors: s.botErrors.slice(0, 10) }));
const pass = s.stored === runs && s.botErrors.length === 0 && s.botMismatches === 0 && s.verifierExit === 0 && s.verifierSummary.includes(`${runs}/${runs} runs verified`);
console.log(pass ? `M1 EXIT TEST PASSED: verifier reproduced ${runs}/${runs} server results` : 'M1 EXIT TEST FAILED');
process.exit(pass ? 0 : 1);
