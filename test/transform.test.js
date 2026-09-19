// Unit tests for the pure transform layer — including the regression test for
// the duplicate-event bug (same instant, different string formats, ±1s drift).

const test = require('node:test');
const assert = require('node:assert');
const {
  cocStamp, sameInstant, warKey, capitalSeasonKey, cwlSeasonKey,
  warRows, capitalRows, capitalAttackRows, warResultFromSummary,
  sortedWarAttacks,
} = require('../lib/transform');

const CLAN = '#2C89UQJ8P';

test('cocStamp normalizes the CoC compact format to canonical ISO', () => {
  assert.strictEqual(cocStamp('20260915T195740.000Z'), '2026-09-15T19:57:40.000Z');
});

test('cocStamp normalizes PostgREST +00:00 format to the same canonical ISO', () => {
  assert.strictEqual(cocStamp('2026-09-15T19:57:40+00:00'), '2026-09-15T19:57:40.000Z');
});

test('REGRESSION: same instant in different formats yields the same war_key', () => {
  // This is exactly the bug that duplicated wars in the old database: the CoC
  // API returns ".000Z", PostgREST returns "+00:00", and string keys differ.
  const fromCoc = warKey(CLAN, '20260915T195740.000Z');
  const fromDb = warKey(CLAN, '2026-09-15T19:57:40+00:00');
  const fromIso = warKey(CLAN, '2026-09-15T19:57:40.000Z');
  assert.strictEqual(fromCoc, fromDb);
  assert.strictEqual(fromCoc, fromIso);
});

test('sameInstant matches across formats and rejects different instants', () => {
  assert.strictEqual(sameInstant('20260915T195740.000Z', '2026-09-15T19:57:40+00:00'), true);
  assert.strictEqual(sameInstant('20260915T195740.000Z', '20260915T195741.000Z'), false);
});

test('capital and CWL season keys embed normalized instants', () => {
  assert.strictEqual(capitalSeasonKey(CLAN, '20260913T182241.000Z'), `CR:${CLAN}:2026-09-13T18:22:41.000Z`);
  assert.strictEqual(cwlSeasonKey(CLAN, '2026-09'), `CWL:${CLAN}:2026-09`);
});

test('warRows builds members including zero-attack players', () => {
  const war = {
    state: 'warEnded',
    teamSize: 2,
    startTime: '20260915T120000.000Z',
    endTime: '20260915T195740.000Z',
    clan: {
      tag: CLAN, name: 'Us', stars: 3, destructionPercentage: 55.5,
      members: [
        { tag: '#P1', name: 'alpha', mapPosition: 1, attacks: [{ defenderTag: '#E1', stars: 3, destructionPercentage: 90, order: 1 }] },
        { tag: '#P2', name: 'beta', mapPosition: 2, attacks: [] },
      ],
    },
    opponent: {
      tag: '#OPP', name: 'Them', stars: 1, destructionPercentage: 30,
      members: [
        { tag: '#E1', name: 'enemy1', mapPosition: 1, attacks: [{ defenderTag: '#P1', stars: 1, destructionPercentage: 40, order: 1 }] },
      ],
    },
  };
  const rows = warRows(war, CLAN, warKey(CLAN, war.endTime));
  assert.strictEqual(rows.members.length, 2);
  const zero = rows.members.find(m => m.player_tag === '#P2');
  assert.strictEqual(zero.attacks_used, 0); // zero-attack player recorded
  assert.strictEqual(rows.attacks.length, 2); // our 1 + their 1
  assert.deepStrictEqual(rows.war.data.result, 'win');
});

test('warResultFromSummary prefers the explicit warlog result and normalizes tie', () => {
  assert.strictEqual(warResultFromSummary({ result: 'lose' }, null, null), 'lose');
  assert.strictEqual(warResultFromSummary({ result: 'tie' }, null, null), 'tie');
  assert.strictEqual(
    warResultFromSummary({ state: 'warEnded' }, { stars: 5, destructionPercentage: 80 }, { stars: 5, destructionPercentage: 70 }),
    'win'
  );
});

test('sortedWarAttacks orders by map position then attack order', () => {
  const members = [
    { tag: '#B', name: 'b', mapPosition: 2, attacks: [{ order: 1 }, { order: 2 }] },
    { tag: '#A', name: 'a', mapPosition: 1, attacks: [{ order: 2 }, { order: 1 }] },
  ];
  const rows = sortedWarAttacks(members);
  assert.deepStrictEqual(rows.map(r => [r.member.tag, r.order]), [['#A', 1], ['#A', 2], ['#B', 1], ['#B', 2]]);
});

test('capitalRows computes absentees from the roster minus attackers', () => {
  const season = {
    startTime: '20260913T182241.000Z',
    capitalTotalLoot: 12345,
    raidsCompleted: 8,
    totalAttacks: 40,
    members: [
      { tag: '#P1', name: 'alpha', attacks: 5, attackLimit: 5, bonusAttackLimit: 1, capitalResourcesLooted: 500 },
    ],
  };
  const roster = [
    { tag: '#P1', name: 'alpha' },
    { tag: '#P2', name: 'beta' },
    { tag: '#P3', name: 'gamma' },
  ];
  const row = capitalRows(season, CLAN, capitalSeasonKey(CLAN, season.startTime), roster);
  assert.deepStrictEqual(row.data.absentees, ['beta', 'gamma']);
  assert.strictEqual(row.data.members[0].attackLimit, 6); // limit + bonus
});

test('capitalAttackRows numbers attacks per attacker/opponent/district', () => {
  const season = {
    startTime: '20260913T182241.000Z',
    attackLog: [
      {
        defender: { tag: '#D1', name: 'Enemy One' },
        districts: [
          { id: 1, name: 'Barbarian Camp', attacks: [
            { attacker: { tag: '#P1', name: 'alpha' }, stars: 2, destructionPercent: 80 },
            { attacker: { tag: '#P1', name: 'alpha' }, stars: 3, destructionPercent: 100 },
          ] },
        ],
      },
    ],
  };
  const rows = capitalAttackRows(season, CLAN, capitalSeasonKey(CLAN, season.startTime));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].attack_number, 1);
  assert.strictEqual(rows[1].attack_number, 2);
  assert.strictEqual(rows[0].district_name, 'Barbarian Camp');
});
