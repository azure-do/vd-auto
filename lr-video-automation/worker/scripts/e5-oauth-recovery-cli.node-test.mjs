import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_COMPANY_ACCOUNT_ID,
  APPROVED_DEV_DATABASE_ID,
  APPROVED_DEV_DATABASE_NAME,
  assertApprovedRecoveryConfig,
  assertCompanyMembership,
  buildExecuteSql,
  classifyPreview,
  parseRecoveryArgs,
  REMOTE_COMPANY_CONFIRMATION,
  runRecoveryFlow,
} from "./e5-oauth-recovery-cli-lib.mjs";

test("preview is the default and remote execution requires both confirmations", () => {
  const preview = parseRecoveryArgs(["--expected-generation", "7", "--operator-id", "ops:youtube"]);
  assert.equal(preview.execute, false);
  assert.throws(() => parseRecoveryArgs([
    "--expected-generation", "7", "--operator-id", "ops:youtube", "--execute", "--remote",
    "--confirm-google-revoked",
  ]), /company account/);
  const execute = parseRecoveryArgs([
    "--expected-generation", "7", "--operator-id", "ops:youtube", "--execute", "--remote",
    "--confirm-google-revoked", "--confirm-company-account", REMOTE_COMPANY_CONFIRMATION,
  ]);
  assert.equal(execute.execute, true);
  assert.throws(() => parseRecoveryArgs([
    "--expected-generation", "7", "--operator-id", "ops:youtube",
    "--config", "alternate.jsonc",
  ]), /unknown option/);
});

test("operator IDs reject emails and SQL injection input", () => {
  for (const operatorId of ["ops@example.invalid", "x';DROP_TABLE;x", "ab"]) {
    assert.throws(() => parseRecoveryArgs([
      "--expected-generation", "7", "--operator-id", operatorId,
    ]), /operator ID/);
  }
});

test("execution SQL has fixed recovery action, generation fence, and no operator ID", () => {
  const sql = buildExecuteSql({
    expectedGeneration: 7,
    operatorId: "ops:youtube",
    occurredAt: "2026-08-30T01:02:03.000Z",
  });
  assert.match(sql, /action, reason_code/);
  assert.match(sql, /'oauth\.recovered'/);
  assert.match(sql, /generation=7 AND operation='ERROR'/);
  assert.match(sql, /generation=8, operation='READY'/);
  assert.match(sql, /status IN \('PENDING','CONSUMING'\)/);
  assert.doesNotMatch(sql, /ops:youtube/);
  assert.doesNotMatch(sql, /\*/);
});

test("already recovered is recognized without a second write", () => {
  assert.deepEqual(classifyPreview({
    recovery_audits: 1, generation: 8, operation: "READY",
    owner_present: 0, expiry_present: 0,
  }, 7, true), { status: "ALREADY_RECOVERED", blockers: [] });
});

test("remote preview and execution reject invalid membership before any D1 read or write", () => {
  const companyId = APPROVED_COMPANY_ACCOUNT_ID;
  assert.doesNotThrow(() => assertCompanyMembership({
    loggedIn: true,
    accounts: [{ id: companyId }],
  }, companyId));

  const rejectedWhoami = [
    { loggedIn: true, accounts: [{ id: "b".repeat(32) }] },
    { loggedIn: false, accounts: [] },
    { loggedIn: true, accounts: [{ id: companyId }, { id: "b".repeat(32) }] },
    null,
  ];
  for (const execute of [false, true]) {
    for (const whoami of rejectedWhoami) {
      let reads = 0;
      let writes = 0;
      assert.throws(() => runRecoveryFlow(
        { execute, remote: true },
        {
          verifyApprovedConfig: () => undefined,
          verifyRemoteAccount: () => assertCompanyMembership(whoami, companyId),
          readPreview: () => { reads += 1; return { status: "READY_TO_RECOVER", blockers: [] }; },
          executeRecovery: () => { writes += 1; },
          now: () => new Date("2026-08-30T01:02:03.000Z"),
        },
      ));
      assert.equal(reads, 0);
      assert.equal(writes, 0);
    }
  }
});

test("alternate account or D1 config is rejected before whoami and D1", () => {
  const approved = {
    account_id: APPROVED_COMPANY_ACCOUNT_ID,
    d1_databases: [{
      binding: "DB",
      database_name: APPROVED_DEV_DATABASE_NAME,
      database_id: APPROVED_DEV_DATABASE_ID,
    }],
  };
  const alternates = [
    { ...approved, account_id: "b".repeat(32) },
    { ...approved, d1_databases: [{ ...approved.d1_databases[0], database_name: "personal-db" }] },
    { ...approved, d1_databases: [{ ...approved.d1_databases[0], database_id: "00000000-0000-0000-0000-000000000000" }] },
    { ...approved, d1_databases: [...approved.d1_databases, { binding: "OTHER", database_name: "other", database_id: "other" }] },
  ];
  for (const config of alternates) {
    let whoamiCalls = 0;
    let reads = 0;
    let writes = 0;
    assert.throws(() => runRecoveryFlow(
      { execute: false, remote: true },
      {
        verifyApprovedConfig: () => assertApprovedRecoveryConfig(config),
        verifyRemoteAccount: () => { whoamiCalls += 1; },
        readPreview: () => { reads += 1; return { status: "BLOCKED", blockers: [] }; },
        executeRecovery: () => { writes += 1; },
        now: () => new Date("2026-08-30T01:02:03.000Z"),
      },
    ));
    assert.equal(whoamiCalls, 0);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
  }
});

test("the fixed approved config and one matching membership allow remote preview", () => {
  const order = [];
  const result = runRecoveryFlow(
    { execute: false, remote: true },
    {
      verifyApprovedConfig: () => {
        assertApprovedRecoveryConfig({
          account_id: APPROVED_COMPANY_ACCOUNT_ID,
          d1_databases: [{
            binding: "DB",
            database_name: APPROVED_DEV_DATABASE_NAME,
            database_id: APPROVED_DEV_DATABASE_ID,
          }],
        });
        order.push("config");
      },
      verifyRemoteAccount: () => {
        assertCompanyMembership({
          loggedIn: true,
          accounts: [{ id: APPROVED_COMPANY_ACCOUNT_ID }],
        }, APPROVED_COMPANY_ACCOUNT_ID);
        order.push("membership");
      },
      readPreview: () => {
        order.push("read");
        return { status: "BLOCKED", blockers: ["CONTROL_NOT_ERROR"] };
      },
      executeRecovery: () => { throw new Error("unexpected write"); },
      now: () => new Date("2026-08-30T01:02:03.000Z"),
    },
  );
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(order, ["config", "membership", "read"]);
});
