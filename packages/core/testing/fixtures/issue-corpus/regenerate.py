"""Optional one-off regeneration: Python + pyarrow==23.0.1; no test dependency."""
import hashlib
import json
import pathlib
import re
import sys
import subprocess
import pyarrow.parquet as parquet

REVISION = "e344be7b84d199661a9956036991e1fc25715a47"
SOURCE_SHA256 = "09453eefae39e45a969ab0bee72ca0e188fe79dc50403b0f2a78c39894f5d1a3"
source = pathlib.Path(sys.argv[1])
assert hashlib.sha256(source.read_bytes()).hexdigest() == SOURCE_SHA256
rows = parquet.read_table(source).to_pylist()
# Body-length tertiles x fewer than five / at least five comments. Four
# evenly spaced issue numbers per stratum, including endpoints; no savings score.
issues = sorted((r for r in rows if not r["pull_request"] or not r["pull_request"]["url"]),
                key=lambda r: (len(r["body"] or ""), r["number"]))
selected = []
for third in range(3):
    group = issues[len(issues)*third//3:len(issues)*(third+1)//3]
    for dense in (False, True):
        bucket = sorted((r for r in group if (len(r["comments"] or []) >= 5) == dense),
                        key=lambda r: r["number"])
        selected.extend(bucket[(len(bucket)-1)*i//3] for i in range(4))

# Replace known profile logins anywhere, longest first; comments have no author
# metadata in this source, so never infer their authors from mentions.
logins = sorted({r["user"]["login"] for r in rows if r["user"]}, key=lambda s: (-len(s), s))
def normalize(text):
    text = text or ""
    for login in logins:
        text = re.sub(r"(?<![\w-])" + re.escape(login) + r"(?![\w-])", "[actor]", text)
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", text)
    text = re.sub(r"(?<!\w)@(?!placeholder\b|highlight\b|property\b|classmethod\b|pytest\b|require_)[A-Za-z0-9_-]+", "[mention]", text)
    text = re.sub(r"(?i)([a-z]:\\users\\)[^\\\s]+", r"\1[user]", text)
    text = re.sub(r"pytest-of-[^/\s']+", "pytest-of-[user]", text)
    text = text.replace("Hi Mario", "Hi [actor]").replace("唐合乐-9-3.jpg", "[image].jpg")
    text = re.sub(r"/(?:home|Users)/[^/\s]+", "/home/[user]", text)
    text = re.sub(r"\b(?:hf_|ghp_)[A-Za-z0-9]+", "[credential]", text)
    return text

output = []
for r in sorted(selected, key=lambda r: r["number"]):
    original = {"title": r["title"], "body": r["body"] or "", "comments": r["comments"] or []}
    normalized = {"title": normalize(original["title"]), "body": normalize(original["body"]),
                  "comments": [normalize(c) for c in original["comments"]]}
    digest = lambda obj: hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    output.append({"number": r["number"], "url": r["html_url"],
                   "actor": f"source-actor-{r['number']}", "sourceTextSha256": digest(original),
                   "contentSha256": digest(normalized), **normalized})
root = pathlib.Path(__file__).resolve().parent
repo = root.parents[4]
def format_json(path):
    subprocess.run([str(repo / "node_modules/.bin/oxfmt"), str(path)], cwd=repo, check=True)
(root / "issues.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
format_json(root / "issues.json")
manifest = {"dataset": "https://huggingface.co/datasets/helmo/github-issues", "revision": REVISION,
            "input": "data/train-00000-of-00001.parquet", "inputSha256": SOURCE_SHA256,
            "normalizationVersion": 2, "license": "Apache-2.0", "issueNumbers": [r["number"] for r in output],
            "fixtureSha256": hashlib.sha256((root / "issues.json").read_bytes()).hexdigest()}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
format_json(root / "manifest.json")
