import { readFileSync } from 'node:fs';

const PRIMER_CSS_URL = new URL('../node_modules/@primer/css/dist/primer.css', import.meta.url);

export function readPrimerCss() {
  try {
    return readFileSync(PRIMER_CSS_URL, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Primer CSS is missing. Run `npm ci` in the application directory before starting the dashboard or generating HTML reports.', { cause: error });
    }
    throw error;
  }
}
