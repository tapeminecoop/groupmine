#!/usr/bin/env python3
"""Generates assertions.json for the SALUS remediation evidence from the recorded run in run/.

Every requirement of the remediation brief is listed with the evidence that covers it: a Solidity test
(from run/solidity-tests.json or the FFI steps in run/run-manifest.json), a fork test
(run/fork-test.json), an end-to-end check (run/local-e2e.json, run/fork-e2e.json, run/fork-safe-e2e.json),
the canary rehearsal (run/canary-fork/summary.json) or a run step. evidenceStatus is PASS only if every
item passed, NOT_RUN if any item is missing from the run. Nothing is asserted by hand.
  python3 -I assertions.py <evidence directory>
"""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
run = root / "run"
manifest = json.loads((run / "run-manifest.json").read_text())
steps = {s["name"]: s for s in manifest["steps"]}
solidity = json.loads((run / "solidity-tests.json").read_text())["suites"]
fork = {r["name"]: r["status"] for r in json.loads((run / "fork-test.json").read_text())["results"]}
e2e = {name: json.loads((run / f"{name}.json").read_text())["checks"] for name in ("local-e2e", "fork-e2e", "fork-safe-e2e")}
canary = json.loads((run / "canary-fork" / "summary.json").read_text())
ffi = {}
for step in ("audit-tests", "salus-differential"):
    for r in steps.get(step, {}).get("summary", {}).get("results", []):
        ffi[(r["suite"], r["name"].split("(")[0])] = r["status"]


def sol(suite, test):
    for name, result in solidity.get(suite, {}).items():
        if name.split("(")[0] == test:
            return {"kind": "solidity", "ref": f"{suite}.{test}", "result": result["status"], "ok": result["status"] == "Success"}
    status = ffi.get((suite, test))
    if status is not None:
        return {"kind": "solidity-ffi", "ref": f"{suite}.{test}", "result": status, "ok": status == "Success"}
    return {"kind": "solidity", "ref": f"{suite}.{test}", "result": None, "ok": None}


def frk(test):
    status = next((s for n, s in fork.items() if n.split("(")[0] == test), None)
    return {"kind": "fork", "ref": f"test/fork {test}", "result": status, "ok": None if status is None else status == "Success"}


def chk(run_name, check):
    value = e2e[run_name].get(check)
    return {"kind": "e2e", "ref": f"{run_name}.checks.{check}", "result": value, "ok": value}


def step(name):
    s = steps.get(name)
    return {"kind": "step", "ref": f"run-manifest step {name}", "result": None if s is None else s["status"], "ok": None if s is None else s["status"] == "PASS"}


A, C, F, I = "SalusAdmissionTest", "SalusCarriedIncomeTest", "SalusFinalityTest", "PoolInvariantTest"
REQUIREMENTS = [
    # SALUS finding #1
    ("F1-1", "#1 successful atomic admission of an ACTIVE miner", [sol(A, "testAtomicAdmissionOfAnActiveMiner"), frk("testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder")]),
    ("F1-2", "#1 revocation before admission makes the admission revert", [sol(A, "testRevocationBeforeAdmissionRevertsTheAdmission"), frk("testForkInactiveMinerAdmissionRevertsAndStaysWithTheWallet")]),
    ("F1-3", "#1 a failed admission leaves the miner with the original wallet", [sol(A, "testRevocationBeforeAdmissionRevertsTheAdmission"), sol(A, "testRolledBackAdmissionDoesNotAlterRegisteredTotalsOrAccounting"), sol(A, "testMissingApprovalOrForeignOwnershipRevertsAtomically")]),
    ("F1-4", "#1 a failed admission alters no registered totals or accounting", [sol(A, "testRolledBackAdmissionDoesNotAlterRegisteredTotalsOrAccounting")]),
    ("F1-5", "#1 a failing incoming Mining reward collection rolls back the whole admission", [sol(A, "testIncomingRewardCollectionFailureRollsBackTheWholeAdmission"), sol(C, "testIncomingClaimFailureRollsBackTheCarriedAttribution")]),
    ("F1-6", "#1 a successful initial admission establishes a valid NAND/LATCH composition", [sol(A, "testInitialAdmissionEstablishesTheComposition")]),
    ("F1-7", "#1 a direct NFT transfer does not register a miner", [sol(A, "testDirectTransferDoesNotRegisterAMiner"), frk("testForkWhitelistAfterRenounceAndBypassRejection")]),
    ("F1-8", "#1 the unsupported direct-transfer/revocation scenario stays documented", [sol(A, "testUnsupportedDirectTransferThenRevocationLeavesItsIncomeUnrecognized"), sol(A, "testRegisterAfterPlainTransferBooksEarlierClaimsUnderTheCurrentComposition"), frk("testForkPlainTransferThenRegisterWindow")]),
    # SALUS finding #2
    ("F2-1", "#2 single NAND-only miner", [sol(C, "testSingleNandOnlyMiner")]),
    ("F2-2", "#2 single LATCH-only miner", [sol(C, "testSingleLatchOnlyMiner")]),
    ("F2-3", "#2 mixed NAND/LATCH miner", [sol(C, "testSingleMixedMiner")]),
    ("F2-4", "#2 multiple miners in one batch", [sol(C, "testReversedBatchOrderGivesTheSameLedger"), sol(C, "testFuzzCarriedAttributionIsIndependentOfOrderAndPartition"), frk("testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder")]),
    ("F2-5", "#2 reversed batch order", [sol(C, "testReversedBatchOrderGivesTheSameLedger"), sol(C, "testSalusExampleIsIndependentOfAdmissionOrder"), frk("testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder")]),
    ("F2-6", "#2 reversed sequential admission order; sequential equals batch", [sol(C, "testReversedSequentialOrderAndBatchGiveTheSameLedger"), sol(C, "testSalusExampleIsIndependentOfAdmissionOrder"), sol(C, "testFuzzCarriedAttributionIsIndependentOfOrderAndPartition")]),
    ("F2-7", "#2 incoming miner with zero carried BEM", [sol(C, "testZeroCarriedIncome")]),
    ("F2-8", "#2 incoming miner with positive carried BEM", [sol(C, "testPositiveCarriedIncomeIsRecordedPerMinerWithItsUnits")]),
    ("F2-9", "#2 pending() == 0 followed by a positive actual claim", [sol(C, "testPendingZeroButPositiveClaimIsAttributedByTheActualBalanceDelta"), frk("testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder")]),
    ("F2-10", "#2 existing pool income before admission", [sol(C, "testExistingPoolIncomeBeforeAdmissionStaysWithTheOldComposition"), frk("testForkBoundaryWithThreeOldMinersAndAnIncomingBatch")]),
    ("F2-11", "#2 old miners with accumulated income; several, strict settlement", [sol(C, "testMultipleExistingMinersSettleStrictlyUnderTheOldComposition"), frk("testForkBoundaryWithThreeOldMinersAndAnIncomingBatch")]),
    ("F2-12", "#2 new Mining claim failure and complete rollback", [sol(C, "testIncomingClaimFailureRollsBackTheCarriedAttribution")]),
    ("F2-13", "#2 very small raw BEM amounts", [sol(C, "testVerySmallRawAmountsAccumulateExactly")]),
    ("F2-14", "#2 fractional allocation and rounding boundaries", [sol(C, "testFractionalAllocationAndRoundingBoundaries"), sol("RoundingPolicyTest", "testSameRatioCheckpointsChangeLifetimeCategoryTotals")]),
    ("F2-15", "#2 receipt transfers before and after admission; repeated claims, no double payment", [sol(C, "testReceiptTransfersBeforeAndAfterAdmissionAndNoDoublePayment")]),
    ("F2-16", "#2 A/B/C accounting and sink settlement", [sol(C, "testABAndSinkAccrueOnCarriedIncomeAndSettleOnRelease")]),
    ("F2-17", "#2 independent reconciliation of all five revenue accounts", [sol(C, "testFiveRevenueAccountsReconcileIndependently")]),
    ("F2-18", "#2 independent reference model (differential, FFI)", [sol("SalusDifferentialTest", "testFuzzLedgerMatchesTheSalusReferenceModel"), sol("SalusDifferentialTest", "testSalusExampleMatchesTheModelInEveryOrder"), step("salus-differential")]),
    ("F2-19", "#2 the SALUS example: NAND 150 / LATCH 50 in every order, then 15 : 5", [sol(C, "testSalusExampleIsIndependentOfAdmissionOrder"), sol("SalusDifferentialTest", "testSalusExampleMatchesTheModelInEveryOrder")]),
    ("F2-20", "#2 real protocol on an isolated BSC fork", [frk("testForkCarriedIncomeIsAttributedPerMinerAndIndependentOfOrder"), frk("testForkBoundaryWithThreeOldMinersAndAnIncomingBatch"), frk("testForkStrictAdmissionBoundaryWithRealMiners"), chk("fork-e2e", "realBoundaryMatchesOldPeriodAndOwnBurnModel")]),
    # SALUS finding #3
    ("F3-1", "#3 NAND issuance not finalized", [sol(F, "testNandIssuanceNotFinalizedBlocksCustody")]),
    ("F3-2", "#3 LATCH issuance not finalized", [sol(F, "testLatchIssuanceNotFinalizedBlocksCustody")]),
    ("F3-3", "#3 NAND owner not zero", [sol(F, "testNandOwnerNotRenouncedBlocksTheFirstAdmission")]),
    ("F3-4", "#3 LATCH owner not zero", [sol(F, "testLatchOwnerNotRenouncedBlocksTheFirstAdmission")]),
    ("F3-5", "#3 distributor allocation not finalized", [sol(F, "testDistributorAllocationNotFinalizedBlocksActivationAndCustody")]),
    ("F3-6", "#3 distributor owner not zero", [sol(F, "testDistributorOwnerNotRenouncedBlocksTheFirstAdmission"), sol(F, "testCompletedOwnershipTransferKeepsCustodyClosed")]),
    ("F3-7", "#3 pool not activated", [sol(F, "testPoolNotActivatedBlocksAdmission")]),
    ("F3-8", "#3 pool owner not zero (mandatory gate)", [sol(F, "testPoolOwnerNotRenouncedBlocksTheFirstAdmission")]),
    ("F3-9", "#3 incorrect distributor binding", [sol(F, "testIncorrectDistributorBindingIsRefused"), sol(F, "testBindingChecksReportedViewsNotCode"), chk("local-e2e", "distributorBindingIsOneTime"), chk("local-e2e", "activationRefusedWithoutDistributorBinding")]),
    ("F3-10", "#3 incorrect receipt addresses", [sol(F, "testIncorrectReceiptAddressesAreRefused")]),
    ("F3-11", "#3 incorrect finalized supplies", [sol(F, "testIncorrectFinalizedSuppliesAreRefused")]),
    ("F3-12", "#3 successful admission after all conditions", [sol(F, "testSuccessfulAdmissionAfterEveryConditionAndNoRenunciationByThePool"), frk("testForkFinalityGateOnRealProtocol"), chk("local-e2e", "readyForFirstAdmission"), chk("fork-safe-e2e", "readyForFirstAdmission")]),
    ("F3-13", "#3 subsequent admissions after ownership renunciation, no liveness dependency", [sol(F, "testLaterAdmissionsAfterRenunciationNeedNoFurtherChecks")]),
    ("F3-14", "#3 ordinary receipt transfers; delivery after distributor renunciation; BEM claims and A/B release after pool renunciation", [sol(F, "testReceiptsDeliverTransferAndClaimWithoutAnyOwner")]),
    ("F3-15", "#3 no post-initialization privileged power", [sol(F, "testNoPrivilegedPowerRemainsAfterInitialization"), sol(F, "testPendingOrCompletedOwnershipTransfersAreHandled")]),
    ("F3-16", "#3 tooling cannot silently bypass the requirements", [chk("local-e2e", "cliRefusesTheFirstAdmissionBeforeFinality"), chk("local-e2e", "chainRefusesTheFirstAdmissionBeforeFinality"), chk("fork-e2e", "custodyClosedWhileOwnersRemain")]),
    ("F3-17", "#3 real protocol", [frk("testForkFinalityGateOnRealProtocol")]),
    # Invariants
    ("INV-1", "invariant: carried-income allocation independent of admission order", [sol(I, "invariantCarriedIncomeIsIndependentOfAdmissionOrder")]),
    ("INV-2", "invariant: no double recognition of incoming BEM", [sol(I, "invariantModelMatchesTheLedger"), sol(I, "invariantRecognitionPaymentsAndLedgerIdentity")]),
    ("INV-3", "invariant: correct cumulative A/B/C accrual", [sol(I, "invariantFourAccountConservation")]),
    ("INV-4", "invariant: total paid never exceeds recognized income", [sol(I, "invariantRecognitionPaymentsAndLedgerIdentity")]),
    ("INV-5", "invariant: receipt entitlement monotonicity", [sol(I, "invariantEntitlementsNeverDecrease")]),
    ("INV-6", "invariant: previous paid histories remain valid", [sol(I, "invariantPerIdHistories")]),
    ("INV-7", "invariant: failed admission causes complete rollback", [sol(I, "invariantModelMatchesTheLedger")]),
    ("INV-8", "invariant: no first admission before finality and renunciation", [sol("SalusFinalityInvariantTest", "invariantNoAdmissionBeforeFinality"), sol("SalusFinalityInvariantTest", "invariantCustodyOpensOnlyWithItsFirstAdmission")]),
    ("INV-9", "invariant: continued operation after ownership renunciation", [sol(I, "invariantCustodyOnlyAfterFinality")]),
    ("INV-10", "invariant: BEM conservation including rounding residue", [sol(I, "invariantFourAccountConservation")]),
    # Tooling, artifacts, canary
    ("T-1", "build sizes within EIP-170 / EIP-3860", [step("build-sizes")]),
    ("T-2", "SDK ABI and bytecode equal the tested build", [step("export-abi")]),
    ("T-3", "SDK tests and TypeScript typecheck", [step("sdk-tests"), step("typecheck"), step("audit-sdk-tests")]),
    ("T-4", "local end to end with the new initialization and acceptance example", [step("local-e2e"), chk("local-e2e", "acceptanceExampleCarriedByOwnBurnNand100Latch100"), chk("local-e2e", "carriedRecordsReconcile")]),
    ("T-5", "fork and Safe end to end", [step("fork-e2e"), step("fork-safe-e2e"), chk("fork-safe-e2e", "distributorBoundOnce")]),
    ("T-6", "internal review suites still pass (adapted where superseded)", [step("audit-tests"), step("solidity-tests")]),
    ("T-7", "canary-3 local rehearsal with preserved recovery restrictions", [{"kind": "canary", "ref": "canary-fork/summary.json status", "result": canary.get("status"), "ok": canary.get("status") == "PASS"}, step("canary-fork-rehearsal")]),
    ("T-8", "largest-wallet gate", [step("largest-wallet")]),
]

out = []
counts = {}
for rid, text, evidence in REQUIREMENTS:
    oks = [e["ok"] for e in evidence]
    status = "NOT_RUN" if any(o is None for o in oks) else "PASS" if all(oks) else "FAIL"
    counts[status] = counts.get(status, 0) + 1
    out.append({"id": rid, "requirement": text, "evidenceStatus": status, "evidence": [{k: v for k, v in e.items() if k != "ok"} for e in evidence]})

result = {
    "schema": "tapeout-salus-remediation-assertions/1",
    "baseRevision": manifest["source"]["baseCommit"],
    "sourceTreeSha256": manifest["source"]["sourceTreeSha256"],
    "runOverall": manifest["overall"],
    "method": __doc__.strip().splitlines()[0] + " evidenceStatus is PASS only if every item passed in the recorded run, NOT_RUN if any item is absent from it.",
    "counts": counts,
    "assertions": out,
}
(root / "assertions.json").write_text(json.dumps(result, indent=1) + "\n")
print(json.dumps({"counts": counts, "runOverall": manifest["overall"]}))
