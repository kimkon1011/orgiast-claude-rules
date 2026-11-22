import { sheetsMetadata, sheetsGet } from "../tools/lib/sheets-dwd.mjs";
const id = "1Qa5bPpvjgpm2lFPfeG08jVMem1FWk1QkbsCHSf5eS4o";
const tab = "打ち手";

const meta = await sheetsMetadata(id);
console.log("Tabs:", JSON.stringify(meta.sheets.map(s => s.properties.title)));
const h = await sheetsGet(id, tab + "!A1:K1");
console.log("H:", JSON.stringify(h));
const r5 = await sheetsGet(id, tab + "!A5:K5");
console.log("R5:", JSON.stringify(r5));
const i5 = await sheetsGet(id, tab + "!I5");
const j5 = await sheetsGet(id, tab + "!J5");
const k5 = await sheetsGet(id, tab + "!K5");
console.log("I5:", JSON.stringify(i5), "J5:", JSON.stringify(j5), "K5:", JSON.stringify(k5));