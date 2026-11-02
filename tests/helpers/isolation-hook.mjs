// Loaded by tests/run.mjs before every test file (node --import): the network isolation of isolation.cjs, Chrome's included
// for the files that drive a browser (HANGTAG_TEST_BROWSER=1, set by the runner).
import iso from './isolation.cjs';
iso.install({ browser: process.env.HANGTAG_TEST_BROWSER === '1' });
