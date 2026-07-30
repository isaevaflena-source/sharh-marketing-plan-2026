import { writeFile } from "node:fs/promises";

const webhook = `${(process.env.BITRIX_WEBHOOK_URL || "").trim().replace(/\/+$/, "")}/`;
if (webhook === "/") throw new Error("BITRIX_WEBHOOK_URL is not configured");

const periods = [
  ["2026-07-24", "2026-07-26"],
  ["2026-07-27", "2026-08-02"],
  ["2026-08-03", "2026-08-09"],
  ["2026-08-10", "2026-08-16"],
  ["2026-08-17", "2026-08-23"],
  ["2026-08-24", "2026-08-29"]
];
const badStatuses = new Set(["JUNK", "UC_WTJTHD"]);
const bloggerSource = "uc_k6nwk4";

const listParams = start => {
  const p = new URLSearchParams();
  p.set("order[DATE_CREATE]", "ASC");
  p.set("filter[>=DATE_CREATE]", "2026-07-24T00:00:00+03:00");
  p.set("filter[<=DATE_CREATE]", "2026-08-29T23:59:59+03:00");
  ["ID","DATE_CREATE","STATUS_ID","SOURCE_ID","UTM_SOURCE","UTM_MEDIUM","UTM_CAMPAIGN","UF_CRM_1734944627"]
    .forEach(field => p.append("select[]", field));
  p.set("start", String(start));
  return p;
};

async function page(start) {
  const url = new URL("crm.lead.list.json", webhook);
  listParams(start).forEach((value, key) => url.searchParams.append(key, value));
  const response = await fetch(url, {headers: {accept: "application/json"}});
  if (!response.ok) throw new Error(`Bitrix24 returned ${response.status}`);
  return response.json();
}

const first = await page(0);
const leads = [...(first.result || [])];
const total = Number(first.total || leads.length);
for (let start = 50; start < total; start += 50) {
  const next = await page(start);
  leads.push(...(next.result || []));
}

const dateRange = (start, end) => {
  const result = [];
  for (let date = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); date <= last; date.setUTCDate(date.getUTCDate() + 1)) {
    result.push(date.toISOString().slice(0, 10));
  }
  return result;
};
const allDates = periods.flatMap(([start, end]) => dateRange(start, end));
const emptyWeeks = () => periods.map(() => ({leads: 0, bad: 0, sales: 0}));
const emptyDays = () => Object.fromEntries(allDates.map(date => [date, {leads: 0, bad: 0, sales: 0}]));
const channels = [
  {key: "influencer", weeks: emptyWeeks(), days: emptyDays()},
  {key: "direct", weeks: emptyWeeks(), days: emptyDays()},
  {key: "telegram", weeks: emptyWeeks(), days: emptyDays()},
  {key: "other", weeks: emptyWeeks(), days: emptyDays()}
];
const classify = lead => {
  const source = (lead.SOURCE_ID || "").toLowerCase();
  const utmSource = (lead.UTM_SOURCE || "").toLowerCase();
  const medium = (lead.UTM_MEDIUM || "").toLowerCase();
  if (medium.includes("influencer") || medium.includes("public") || source === bloggerSource) return 0;
  if (utmSource.includes("yandex") || medium === "cpc" || medium === "cpa") return 1;
  if (source.includes("telegram") || source === "tg" || utmSource.includes("telegram") || utmSource === "tg" || medium.includes("telegram") || medium === "tg") return 2;
  return 3;
};
const hasBadReason = value => Array.isArray(value) ? value.length > 0 : Boolean(value);

for (const lead of leads) {
  const date = lead.DATE_CREATE?.slice(0, 10);
  const pi = periods.findIndex(([start, end]) => date >= start && date <= end);
  if (pi < 0) continue;
  const channel = channels[classify(lead)];
  const target = channel.weeks[pi];
  const daily = channel.days[date];
  target.leads += 1;
  daily.leads += 1;
  if (badStatuses.has(lead.STATUS_ID || "") || hasBadReason(lead.UF_CRM_1734944627)) {
    target.bad += 1;
    daily.bad += 1;
  }
  if ((lead.STATUS_ID || "") === "CONVERTED") {
    target.sales += 1;
    daily.sales += 1;
  }
}

await writeFile("marketing-b24.json", JSON.stringify({
  updatedAt: new Date().toISOString(),
  source: "Bitrix24",
  totalLeads: leads.length,
  channels
}, null, 2) + "\n");
