# Workflow conformance

What this instance does with every key a workflow can contain.

The point of publishing it: **silence about a gap is how a forge surprises people.** A key that
is accepted and does nothing has not been implemented - the fact that it has not has been
hidden. So every key here has a status and a sentence, including the ones that are missing and
the ones that are deliberately different.

36 keys behave as Actions does, 13 differ on purpose, 4 are not implemented yet, and 1 is refused.

Generated from the conformance table.

## Supported

These do what Actions does. A workflow using only these keys behaves the same here.

| Key | Where | What this instance does |
| --- | --- | --- |
| `on.push` | on | Starts runs, with `branches`, `tags`, `paths` and their `-ignore` forms. |
| `on.pull_request` | on | Starts runs on opened, synchronize and reopened, with `types`, `branches` and `paths`. The definition comes from the base branch. |
| `on.pull_request_target` | on | Asked as its own question against the same version, so a workflow naming only `pull_request` is never started as this. |
| `on.workflow_dispatch` | on | Startable by hand or by API, with inputs of every type checked against what the workflow declared. |
| `on.schedule` | on | Swept every minute; a workflow never swept before waits for its next occurrence rather than firing immediately. |
| `on.issues` | on | Starts runs on opened and closed, with `types`. |
| `on.issue_comment` | on | Starts runs when a comment is created, with `types`. |
| `on.workflow_call` | on | Declares inputs, outputs and secrets, and makes the workflow callable by another in the same repository. |
| `on.repository_dispatch` | on | Started by `POST /api/repos/dispatches` with an `event_type` and a `client_payload`, filtered by `types`. Write access, since starting a run spends the instance's runners. |
| `name` | workflow | Names the workflow everywhere it appears. |
| `env` | workflow | Inherited by every job and step, with the narrowest level winning. |
| `defaults.run` | workflow | `shell` and `working-directory` are inherited by steps; nothing declared anywhere leaves the choice to the runner. |
| `concurrency` | workflow | Groups runs, cancels superseded ones with `cancel-in-progress`, and without it holds the second run in `waiting` until the first finishes - the half of the key most implementations skip, which turns "one deploy at a time" into a label. Released one run at a time, in push order. A group whose expression cannot be resolved is no group at all. |
| `jobs.<id>.runs-on` | job | Matched against a runner's labels, as a string, a list, or a `group`/`labels` mapping. |
| `jobs.<id>.needs` | job | Orders the graph, refuses a cycle by name, and skips a job whose dependency did not succeed rather than leaving it blocked forever. A matrix is every combination of it: `needs: build` waits for all of them and is held back by any one that failed. |
| `jobs.<id>.if` | job | Evaluated when the run is created; a job whose condition is false is `skipped` with the reason recorded. |
| `jobs.<id>.strategy.matrix` | job | Expanded at parse time, including `include` and `exclude`; each combination is its own job. |
| `jobs.<id>.strategy.fail-fast` | job | Defaults to true, as it does on Actions: one combination failing cancels the queued siblings and asks the running ones to stop, with the reason on each row. `fail-fast: false` leaves them alone. |
| `jobs.<id>.env` | job | Overrides the workflow's for this job's steps. |
| `jobs.<id>.permissions` | job | Replaces the workflow's rather than adding to it, which is Actions' rule. |
| `jobs.<id>.concurrency` | job | A group of its own, resolved against the run and the matrix combination. |
| `jobs.<id>.timeout-minutes` | job | Enforced twice: the runner stops between steps and says which step it was about to run, and the control plane sweeps a job that overran whether or not its runner is listening. Six hours when the workflow does not say, which is Actions' default. |
| `jobs.<id>.continue-on-error` | job | The job still shows as failed and the run is not failed by it, and the jobs that `needs:` it are told `success` - which is Actions' rule and the only shape that keeps a flaky suite visible instead of deleted. |
| `jobs.<id>.outputs` | job | Resolved by the runner once the steps they read have run, stored on the run's job, and handed to the jobs that `needs:` it as `needs.<job>.outputs.<name>` alongside `needs.<job>.result`. |
| `steps[*].run` | step | Executed by the runner, in the workspace, with the job's environment and with its `${{ }}` expressions filled in first - which is what makes `echo "${{ steps.build.outputs.name }}"` work. |
| `steps[*].uses` | step | Local, composite and JavaScript actions run; remote ones are fetched and cached, under a policy that allows no host by default. `docker://image` runs where the machine has docker or podman and the operator set `REVIEWOS_ALLOW_CONTAINERS`: the workspace mounts at `/github/workspace`, `args` and `entrypoint` are the container's, and every other `with:` key arrives as `INPUT_*`. An action whose `image:` is a `Dockerfile` is refused by name - building one would make the runner a build host for images from the repository whose workflow it is running. |
| `steps[*].with` | step | Passed to an action as `INPUT_*`, with the action's declared defaults filled in. |
| `steps[*].env` | step | The narrowest environment level, applied over the job's and the workflow's. |
| `steps[*].working-directory` | step | Resolved against the workspace. |
| `steps[*].id` | step | Recorded, and what `steps.<id>.outputs`, `.outcome` and `.conclusion` are keyed on. |
| `steps[*].if` | step | Evaluated by the runner against what the steps before it produced, so `steps.<id>.outputs`, `job.status`, `needs` and `always()` all work. A condition naming no status function carries the implied `success() &&`, and no condition means `success()` - so a step after a failure is skipped unless it asked not to be. A skipped step says which condition skipped it rather than vanishing. |
| `steps[*].timeout-minutes` | step | Enforced per step by the runner, which is the narrow and more useful of the two timeouts: a job allowed sixty minutes that hangs in a thirty-second health check spends fifty-nine of them proving nothing. A step stopped this way says so rather than reading as an ordinary failure. |
| `${{ }} operators` | workflow | Comparison, `&&`, `||`, `!`, indexing and the star filter, with Actions' coercion rules copied deliberately. |
| `workflow commands` | step | `::error::`, `::warning::`, `::notice::`, `::group::`, `::add-mask::` and `::stop-commands::`. An `::error file=…::` becomes an annotation on the diff. |
| `GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY` | step | Written per step and applied to the steps after it; `GITHUB_OUTPUT` is what fills `steps.<id>.outputs`, and `GITHUB_STEP_SUMMARY` is rendered as markdown on the run and on the pull request's checks. |
| `default environment variables` | step | The set a workflow expects - `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `GITHUB_SHA`, `GITHUB_ACTOR`, `GITHUB_WORKFLOW`, `GITHUB_JOB`, `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `RUNNER_OS` and the rest - each also set as `REVIEWOS_*`. `GITHUB_SERVER_URL` is the address the runner actually reached rather than a configured one, because a URL that does not resolve from a runner is worse than none. |

## Different on purpose

These work, and deliberately not the way Actions does. Every one is a decision you should be able to disagree with, so the reason is next to it.

| Key | Where | What this instance does |
| --- | --- | --- |
| `on.release` | on | Defaults to `published` only, where Actions defaults to every activity type. A draft release starting a deployment is the surprise nobody wants; naming `types` opts back in. |
| `on.workflow_run` | on | Starts a run when a named workflow finishes, with `types` and `branches`. Two differences, both deliberate: `workflows:` is required, because a workflow that started after every other one would start after itself; and a `workflow_run` run does not start another - Actions bounds the loop with a depth limit, and there is no honest use for the second hop that `needs:` does not cover. |
| `reviewos.intermediate` | workflow | The one extension at the top level: `skip` lets a run that has started finish and drops the ones that have not, which is what people usually mean when three commits land in a minute and which neither Actions nor Gitea offers. `cancel` is `concurrency.cancel-in-progress` said in one word, and `run` is the default because it is Actions' behaviour. See [extensions](./extensions.md). |
| `permissions` | workflow | Mapped onto this instance's token scopes, and the default is read-only rather than depending on an organization setting, so a workflow behaves the same on every instance. `write-all` does not grant administration. |
| `jobs.<id>.strategy.max-parallel` | job | Honoured at claim time by counting the combinations already running, which is a check rather than a lock: two runners polling in the same instant can both take the last slot. Making it exact would mean a lock held across every claim on the instance. |
| `jobs.<id>.uses` | job | Local reusable workflows are called and their jobs shown in the run. A cross-repository call is refused with a reason rather than half done. |
| `steps[*].continue-on-error` | step | Honoured as a literal `true` only. An expression needs the expression engine at step time, and reading it as truthy text would make every such step unfailable. |
| `steps[*].shell` | step | Recorded and inherited, and the local runner runs `sh` regardless. A runner that only has one shell should say so rather than refuse a file for naming another. |
| `${{ }} functions` | workflow | `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON` and the status functions all work. `hashFiles` is refused rather than answered: it reads a checked-out tree the control plane does not have, and a wrong hash restores the wrong cache. |
| `GITHUB_EVENT_PATH` | step | Written per job and populated. The shapes are this instance's webhook payloads rather than GitHub's, so one integration sees one set of shapes whether it arrived over a webhook or in a job - the common fields (`ref`, `after`, `repository`, `sender`, `pull_request.base.ref`) line up, and the rest do not. Nothing in it carries a URL. |
| `reviewos.wait / block / trigger / group / if-changed / retry / priority / agents / parallelism / artifact-paths / secrets / cancel-on-build-failing / checkout / concurrency-group / adjustments` | job | This instance's own extensions, and the only keys here that are not Actions': a barrier, a gate a person opens, a job that starts another run, a label that groups jobs on the screen, per-job path gating for a monorepository, an automatic retry with a required cap, a queue priority, a `key=value` tag query over what machines report about themselves, `parallelism:` - one job definition run N times, each copy told which it is - `artifact-paths:`, globs the runner collects when the job ends whether it passed or failed - and `secrets:`, naming which credentials a job is given, since a job that receives every secret in scope is a job whose compromised dependency reads the deploy key it never needed - `cancel-on-build-failing:`, which stops a long job once something else has already sunk the run - and `checkout:`, which is depth, sparse paths, submodules, LFS or nothing at all, said on the job rather than as a step with four `with:` keys - and `concurrency-group:` with `concurrency:` and `concurrency-method:`, a named limit shared by every job wearing it across every run and workflow in the repository, which is the deploy lock a run-level group cannot express - and `adjustments:`, which skips or soft-fails one matrix combination, where Actions can only exclude one and cannot tolerate one at all. All four live under one `reviewos:` key so there is one thing to delete, and **GitHub refuses a file that uses them** rather than ignoring them - which is the right failure, since a `block:` that GitHub ignored would be a deployment approval that approves itself. Documented in [extensions](./extensions.md). |
| `contexts` | workflow | `github`, `env`, `job`, `steps`, `needs`, `matrix`, `inputs` and `runner` are readable, and `reviewos` is `github` under this forge's own name. `secrets`, `vars`, `strategy` and `jobs` are not populated yet, and an expression reading one is left as written rather than becoming an empty string. |
| `generated steps (`reviewos-upload`)` | step | A job can add jobs to its own run, which Actions cannot - its nearest thing is a matrix built from `fromJSON` of a prior job's output, where the count varies but not the content. The uploaded document goes through the same parser as a workflow file, cannot raise its own trust level or priority, is refused once the run is finished, and is bounded by depth, per-run and per-upload limits. See [extensions](./extensions.md). |

## Not implemented yet

These are read and do nothing yet. A workflow using one is told - on its run, or on the workflow page - rather than left to wonder why nothing happened.

| Key | Where | What this instance does |
| --- | --- | --- |
| `run-name` | workflow | Accepted and not yet used; runs are named for their workflow. |
| `jobs.<id>.container` | job | Parsed and refused at run time: a job-level container means every step runs inside it, which is isolation rather than one step calling an image, and pretending otherwise would run the steps on the host. A *step* that names an image (`uses: docker://...`) does run; see `steps[*].uses`. If what the image was for is a *toolchain* rather than isolation - `container: node:20` usually is - a pantry dependency file in the repository gets that without an image at all, and the runner puts it on `PATH`. Isolation is a separate machine; see [extensions](./extensions.md). |
| `jobs.<id>.services` | job | Parsed; no service containers are started, and a job that needs one is told rather than failing on a closed port. |
| `jobs.<id>.environment` | job | Parsed; deployment environments and their protection rules are phase 9 work. |

## Refused

These will not be implemented in this form.

| Key | Where | What this instance does |
| --- | --- | --- |
| `::set-output::, ::save-state::` | step | The deprecated command forms are logged as ordinary text rather than honoured. The file protocol replaced them, and a line that vanished is worse than one that did nothing. |
