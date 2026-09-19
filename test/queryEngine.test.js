// Unit tests for the deterministic query engine — the layer that makes
// counts/filters/rankings hallucination-proof. Adapted from the sibling
// project's suite to Riuka's schema.

const test = require('node:test');
const assert = require('node:assert');
const {
  buildQueryPlan, applyAttackUsageFilters, stripNegatedDatasets,
  deterministicWarMembers, deterministicMemberMetric, deterministicRole,
} = require('../lib/queryEngine');

function plan(q) { return buildQueryPlan(q); }

test('scope detection: war / capital / cwl / clan', () => {
  assert.strictEqual(plan('who has one attack left?').scope, 'war');
  assert.strictEqual(plan('who has not attacked in the capital raid?').scope, 'capital');
  assert.strictEqual(plan('who has one attack left in cwl?').scope, 'cwl');
  assert.strictEqual(plan('who has the lowest donations?').scope, 'clan');
});

test('negated datasets do not flip the scope', () => {
  const p = plan('i mean the clan war, not capital raid — who has not attacked?');
  assert.strictEqual(p.scope, 'war');
  assert.strictEqual(p.operation, 'member_attack_usage');
  assert.strictEqual(p.unused, true);
});

test('attack usage filters: unused', () => {
  const rows = [
    { player_name: 'a', player_tag: '#1', attacks_used: 0, attacks_available: 2 },
    { player_name: 'b', player_tag: '#2', attacks_used: 2, attacks_available: 2 },
  ];
  const out = applyAttackUsageFilters(rows, { unused: true, attacks_used: null, attacks_used_min: null, attacks_remaining: null });
  assert.deepStrictEqual(out.map(r => r.player_name), ['a']);
});

test('attack usage filters: N remaining', () => {
  const rows = [
    { player_name: 'a', player_tag: '#1', attacks_used: 1, attacks_available: 2, map_position: 1 },
    { player_name: 'b', player_tag: '#2', attacks_used: 2, attacks_available: 2, map_position: 2 },
    { player_name: 'c', player_tag: '#3', attacks_used: 0, attacks_available: 2, map_position: 3 },
  ];
  const out = applyAttackUsageFilters(rows, { unused: false, attacks_used: null, attacks_used_min: null, attacks_remaining: 1 });
  assert.deepStrictEqual(out.map(r => r.player_name), ['a']);
});

test('attack usage filters: used exactly one / at least one', () => {
  const rows = [
    { player_name: 'a', attacks_used: 1, attacks_available: 2 },
    { player_name: 'b', attacks_used: 2, attacks_available: 2 },
    { player_name: 'c', attacks_used: 0, attacks_available: 2 },
  ];
  const exact = applyAttackUsageFilters(rows, { attacks_used: 1, unused: false, attacks_used_min: null, attacks_remaining: null });
  assert.deepStrictEqual(exact.map(r => r.player_name), ['a']);
  const atLeast = applyAttackUsageFilters(rows, { attacks_used: null, unused: false, attacks_used_min: 1, attacks_remaining: null });
  assert.deepStrictEqual(atLeast.map(r => r.player_name), ['a', 'b']);
});

test('"one attack left" is not misread as "used one attack"', () => {
  const p = plan('who has one attack left?');
  assert.strictEqual(p.attacks_remaining, 1);
  assert.strictEqual(p.attacks_used, null);
});

test('member metric: lowest donations', () => {
  const p = plan('who has the lowest donations?');
  assert.strictEqual(p.operation, 'member_metric');
  assert.strictEqual(p.metric, 'donations');
  assert.strictEqual(p.sort, 'asc');
});

test('member metric: highest trophies', () => {
  const p = plan('who has the most trophies?');
  assert.strictEqual(p.metric, 'trophies');
  assert.strictEqual(p.sort, 'desc');
});

test('role detection maps elder -> admin (CoC raw role)', () => {
  const p = plan('who are the elders?');
  assert.strictEqual(p.operation, 'role_members');
  assert.strictEqual(p.role, 'admin');
  const players = [
    { name: 'a', tag: '#1', role: 'admin' },
    { name: 'b', tag: '#2', role: 'member' },
  ];
  const out = deterministicRole('who are the elders?', players);
  assert.deepStrictEqual(out.rows.map(r => r.name), ['a']);
});

test('"how many members" is a member-count question, not a role question', () => {
  const p = plan('how many members are in the clan?');
  assert.strictEqual(p.operation, 'members');
  assert.strictEqual(p.role, null);
});

test('deterministicMemberMetric sorts by the metric', () => {
  const players = [
    { name: 'a', tag: '#1', donations: 100 },
    { name: 'b', tag: '#2', donations: 50 },
    { name: 'c', tag: '#3', donations: 200 },
  ];
  const out = deterministicMemberMetric('who has the lowest donations?', players);
  assert.deepStrictEqual(out.rows.map(r => r.name), ['b', 'a', 'c']);
});

test('deterministicWarMembers filters with the shared filter implementation', () => {
  const members = [
    { player_name: 'a', player_tag: '#1', attacks_used: 0, attacks_available: 2, map_position: 1 },
    { player_name: 'b', player_tag: '#2', attacks_used: 2, attacks_available: 2, map_position: 2 },
  ];
  const out = deterministicWarMembers('who has not used any attacks?', members);
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.remaining[0].attacks_remaining, 2);
});

test('stripNegatedDatasets removes negated mentions', () => {
  const out = stripNegatedDatasets('not capital raid please');
  assert.strictEqual(out.trim(), 'please');
});

test('opponent and state operations', () => {
  assert.strictEqual(plan('which clan are we at war with?').operation, 'opponent');
  assert.strictEqual(plan('what is the war state?').operation, 'state');
  assert.strictEqual(plan('when does the war end?').operation, 'timing');
});
