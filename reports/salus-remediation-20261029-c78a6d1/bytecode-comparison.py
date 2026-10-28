#!/usr/bin/env python3
"""Writes bytecode-comparison.json: per contract, ABI and code before (BEFORE_OUT, a forge `out/` of the
base revision) and after (AFTER_OUT). Code is "identical", "identical except trailing compiler metadata"
(the CBOR metadata whose length is the last two bytes, stripped from runtime and creation code of equal
length), or "changed".
  python3 -I bytecode-comparison.py BEFORE_OUT AFTER_OUT OUTPUT_JSON
"""
import json
import sys

CONTRACTS = [
    ("TapeoutEntitlementReceipt.sol", "TapeoutEntitlementReceipt"),
    ("TapeoutReceiptDistributor.sol", "TapeoutReceiptDistributor"),
    ("TapeoutMinerPool.sol", "TapeoutMinerPool"),
    ("PoolMath.sol", "PoolMath"),
    ("IMining.sol", "IMining"),
    ("IReceiptDistributor.sol", "IReceiptDistributor"),
    ("RecoverableTapeoutMinerPool.sol", "RecoverableTapeoutMinerPool"),
    ("CanaryParticipant.sol", "CanaryParticipant"),
]


def load(root, source, name):
    try:
        with open(f"{root}/{source}/{name}.json") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def strip(code):
    body = code[2:]
    if len(body) < 4:
        return body
    return body[: -(int(body[-4:], 16) * 2 + 4)]


def size(code):
    return (len(code) - 2) // 2


before_root, after_root, output = sys.argv[1:4]
rows = []
for source, name in CONTRACTS:
    a, b = load(before_root, source, name), load(after_root, source, name)
    row = {"contract": name}
    if a is None:
        row.update({"abi": "new", "code": "new", "after": {"runtimeBytes": size(b["deployedBytecode"]["object"]), "initcodeBytes": size(b["bytecode"]["object"])}})
    else:
        ra, rb = a["deployedBytecode"]["object"], b["deployedBytecode"]["object"]
        ca, cb = a["bytecode"]["object"], b["bytecode"]["object"]
        same_abi = json.dumps(a["abi"], sort_keys=True) == json.dumps(b["abi"], sort_keys=True)
        if ra == rb and ca == cb:
            code = "identical"
        elif len(ra) == len(rb) and len(ca) == len(cb) and strip(ra) == strip(rb) and strip(ca) == strip(cb):
            code = "identical except trailing compiler metadata"
        else:
            code = "changed"
        row.update({"abi": "same" if same_abi else "changed", "code": code,
                    "before": {"runtimeBytes": size(ra), "initcodeBytes": size(ca)}, "after": {"runtimeBytes": size(rb), "initcodeBytes": size(cb)}})
    rows.append(row)
with open(output, "w") as f:
    json.dump({"schema": "tapeout-bytecode-comparison/1", "method": __doc__.strip().splitlines()[0], "contracts": rows}, f, indent=1)
    f.write("\n")
print(json.dumps([(r["contract"], r["abi"], r["code"]) for r in rows]))
