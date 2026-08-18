# The merge queue

"Green on my branch" and "green after everything ahead of me lands" are
different questions, and only the second one decides whether `main` works.

Two pull requests that each pass alone and break together are the ordinary case,
not the exotic one - a renamed function and a new caller of it will do it. A
forge that merges on the first answer breaks the default branch regularly and
blames whoever pushed last.

## What a run is given

The **prospective merge result**: the base branch with everything ahead in the
queue already merged, plus this one. That is the commit that will exist if it
lands, and testing anything else is testing a commit nobody will ever have.

It is built with `merge-tree` plumbing and written to `refs/merge-queue/<number>`
so a runner can check it out like any other ref - a prospective merge that exists
only as an unreferenced object is one git will collect while the run is still
using it. The base branch does **not** move while it is tested.

Entry three is tested on top of one and two as though they had landed. That
speculation is what makes a queue faster than merging one at a time and waiting.

## Landing

Success moves the branch to **exactly the commit that was tested**, guarded by
where the branch was.

Merging again at that moment would produce a different commit from the one the
run went green on - the same tree, different parents - and the thing that was
actually tested would never exist. That is the whole failure a merge queue is
built to prevent, so landing is a ref move, not a second merge.

If the branch moved underneath (somebody pushed directly), the entry goes back to
the queue rather than being forced. The push is not wrong; the assumption was.

## Failing

The entry is **ejected**, not failed. The pull request has not failed - it did
not land *this time, in this order* - and saying so is the difference between a
queue people trust and one they route around. The reason is recorded on the
entry.

**Everything behind it goes back to the queue.** Those entries were tested on top
of a commit that is now never going to exist, so their green is about a history
nobody will have. Not re-testing them is exactly how a merge queue lands the
change that breaks `main`. Positions are kept, so the order people were told is
the order that happens.

An ejected pull request can rejoin, and it goes to the back: a change that
already failed does not get ahead of the changes that have been waiting for it.

## What is not built yet

- **Parallel speculative testing.** One entry is tested at a time. Testing three
  at once doubles the machine cost to save latency, and paying for that before
  anybody has asked is paying for a problem this instance's users have not
  reported.
- **The stall policy.** `stalled()` can say which entries have been testing since
  before a cutoff - a run that died without reporting leaves the whole queue
  waiting on a machine that is never coming back - but what to do about it
  (eject, re-test, tell somebody) is not decided yet.
- **The screen.** The queue is API and engine today; there is no page showing the
  order and the reasons.
