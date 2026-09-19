// Clash of Clans API client via the RoyaleAPI proxy. All requests carry the
// server's COC_TOKEN; the browser never sees it.

const COC_TOKEN = () => process.env.COC_TOKEN;
const BASE = 'https://cocproxy.royaleapi.dev/v1';

async function cocGet(path) {
  const token = COC_TOKEN();
  if (!token) throw new Error('COC_TOKEN is not set on the server');
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`CoC API ${res.status} ${res.statusText} ${text}`.trim());
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const tagPath = (tag) => encodeURIComponent(tag);

const getClan = (clanTag) => cocGet(`/clans/${tagPath(clanTag)}`);
const getCurrentWar = (clanTag) => cocGet(`/clans/${tagPath(clanTag)}/currentwar`);
const getWarLog = (clanTag, limit = 50) => cocGet(`/clans/${tagPath(clanTag)}/warlog?limit=${limit}`);
const getCapitalSeasons = (clanTag, limit = 25) => cocGet(`/clans/${tagPath(clanTag)}/capitalraidseasons?limit=${limit}`);
const getCwlGroup = (clanTag) => cocGet(`/clans/${tagPath(clanTag)}/currentwar/leaguegroup`);
const getCwlWar = (warTag) => cocGet(`/clanwarleagues/wars/${tagPath(warTag)}`);

module.exports = { cocGet, getClan, getCurrentWar, getWarLog, getCapitalSeasons, getCwlGroup, getCwlWar };
