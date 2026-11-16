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

## Run the owner trial

Choose a new local directory and the three [pinned alpha archives](../docs/evidence/PA-028.md#local-alpha-archives). From the repository root, prepare the dedicated DSH Web profile and start its resident on loopback.

```sh
pnpm install --frozen-lockfile
mkdir -p "$PWD/.dshpa"
trial="$PWD/.dshpa/alpha-trial"
node evals/owner-trial.ts prepare "$trial" "$archives"
sh deploy/run-resident.sh "$(command -v node)" "$trial/home" dshpa-alpha-trial "$trial/resident.yml" 0
```

For model-backed tasks, configure an authorized native route and its limits in the prepared overlay before starting the resident. The local owner controls which work and capabilities enter the trial. [Worker setup](../README.md#open-the-local-web-inbox) · [Budget limits](../README.md#set-compute-and-attention-limits) · [Resident operations](../docs/operations.md)

In a second terminal, set `trial` to the same absolute directory. Open the private owner link in your browser and opt in when you are ready to begin. The start command verifies the resident is ready and records the installed archive identity, host and runtime versions, initial instance, and start time. For a disposable rehearsal, use `start "$trial" rehearsal`.

```sh
trial="$PWD/.dshpa/alpha-trial"
node deploy/ops.mjs owner-url "$trial/home/trial-state"
node evals/owner-trial.ts start "$trial" owner
node evals/owner-trial.ts status "$trial"
```

Use the alpha for your own work during seven consecutive 24-hour periods from the recorded start. `status` shows each period's UTC timestamps. At the end of each period, save an observation using the fields below. Count outcomes you explicitly accepted, interruptions you could have avoided, and the seconds spent intervening in the workflow. Record short incident summaries without personal content, credentials or owner links. A full period with no observed activity uses zeros and an empty incident list. Use `partial` when you observed only part of a period.

```json
{
  "coverage": "full",
  "acceptedOutcomes": 0,
  "avoidableInterruptions": 0,
  "interventionSeconds": 0,
  "incidents": []
}
```

```sh
node evals/owner-trial.ts record "$trial" 1 "$trial/observation.json"
node evals/owner-trial.ts status "$trial"
node evals/owner-trial.ts stop "$trial"
```

Save each observation as `observation.json` before recording it against the appropriate day number. Submitting the same day number again replaces that day's record. End the observation interval with `stop`, then stop the foreground resident with Ctrl+C. Keep the artifacts local and retain the profile if you want to reuse it. The report marks full, partial and missing periods separately and totals recorded activity. Owner completion requires a stopped seven-day interval with all seven full records. The Project release decision also reviews the actual evidence. [Evaluation requirements](../docs/07-evaluation-and-release-gates.md)
