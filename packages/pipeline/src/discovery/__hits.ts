import 'dotenv/config';
import { fetchJson, sleep } from '../lib/http.js';
const BASE='https://api.company-information.service.gov.uk';
const auth=()=>({Authorization:`Basic ${Buffer.from(`${process.env.COMPANIES_HOUSE_API_KEY}:`).toString('base64')}`});
const FRAG=['family office','family investment','family holdings','family capital','family trust','single family office','multi family office','private family office'];
const SIC=['64205','64303','66300','64209','70100','64999','64301','64302','64304','64306','66190','70221'];
let totalHits=0, combos=0;
console.log('fragment × SIC → hits AVAILABLE vs 40 we actually took');
for (const f of FRAG) {
  let fragHits=0;
  for (const s of SIC) {
    try {
      const r = await fetchJson<{hits?:number;items?:unknown[]}>(
        `${BASE}/advanced-search/companies?company_name_includes=${encodeURIComponent(f)}&sic_codes=${s}&company_status=active&size=1`,
        {headers:auth(),retries:1});
      const h = r.hits ?? 0; fragHits += h; totalHits += h; combos++;
      await sleep(90);
    } catch {}
  }
  console.log(`  ${f.padEnd(24)} hits across 12 SIC codes = ${fragHits}`);
}
console.log(`\nTOTAL hits across ${combos} combinations : ${totalHits}`);
console.log(`we only ever retrieved                  : up to 40 per combination`);
console.log(`unique candidates currently held         : 442 (411 original + 31 narrow)`);
