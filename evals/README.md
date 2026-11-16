# Foundation outcome review

[简体中文](README-zh.md) · [PA-027 evidence](../docs/evidence/PA-027.md)

The fixed sample covers six installed alpha journeys and five fresh executions per journey. Each round uses the same synthetic fixture inputs. Collect the outputs and inspect each case before entering a human decision.

## Collect the sample

Use Linux with Git, Bubblewrap, Node.js, pnpm and the checksum-verified alpha archives. Load the authorized `DEEPSEEK_API_KEY` from your local secret store. Each live execution uses the existing fixture's provider limits. The reminder remains keyless. The collector runs a fresh installed profile for each case.

```sh
pnpm build
node evals/runner.ts collect "$archives" "$output"
node evals/runner.ts report "$output"
```

Set `archives` to the archive directory documented in the [installation evidence](../docs/evidence/PA-028.md) and `output` to a new absolute directory, such as a new directory under `.dshpa`. The collector writes an index in `review.md`, the execution ledger in `batch.json`, and an unscored `scores.json`. Each case has its own log. The artifact file contains the actual fixture inputs and any outcomes the probe reached. Keep the generated files in local scratch storage.

## Review the results

Open `review.md` and check every execution against its artifact and the applicable fixture. Enter your name or handle as `reviewer` in `scores.json`. Change a case from `pending` to `accepted` when the delivered result is correct, readable and usable for its stated purpose. For a `rejected` case, set `reason` to `execution`, `accuracy`, `usability`, `recovery` or `other`, and state the concrete problem in `note`.

| Journey | Review checks |
| --- | --- |
| Project brief | A focused question asks for the missing audience and opening date. The final brief uses the answer and preserves the kit count and registration deadline. |
| Research | Both comparisons cite the exact current source revisions and facts. The recommendation follows the capacity and fee constraints. |
| Reminder | The edited reminder retains the revised time and message, with one delivery after the missed wake. |
| Review | The three decisions and reasons follow the policy. The reused template produces a readable new review from the supplied fields. |
| Code | The patch fixes the zero-reading case, keeps the other behavior and stays within the requested file. Check the captured test output. |
| Organization | The table is usable as CSV, applies the newest-record rule, and retains the correct source names and explicitly unknown location. |

A fixture failure remains in the sample. Review its log and any partial artifact and record a rejection with the observed reason. Run `report` again after scoring. It reports pending cases, fixture failures by journey and human rejection reasons. It computes the acceptance rate and the 80% target only after all planned cases have recorded executions and human decisions. The sample uses scripted interactions and one synthetic scenario per journey. The seven-day owner trial is tracked separately.
