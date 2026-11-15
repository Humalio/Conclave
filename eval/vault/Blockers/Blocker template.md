---
owner: Case Command
status: active
depends_on: []
tags: [template, blocker]
---
# Blocker template

Copy this note to raise a blocker. Name it `B-NN Short title`. Ask Saoirse for the next number. A blocker is something that stops a milestone, not something that is merely strange; if nothing downstream waits on it, it belongs in the [[Risk register]] instead. If it is strange and nothing waits on it, it belongs in "Anything odd" in your weekly status.

Frontmatter: owner is the team that will clear it; status is open until it is cleared, then closed. List in depends_on the notes whose results show the problem, usually the capture and the explanation it tests.

## Summary

Three or four sentences: what is wrong, what it blocks, and what clears it.

## Background

The facts the blocker rests on. If you are quoting a capture's method, quote it exactly so a reader can find the source.

## Cause

What you believe the cause is, and how sure you are. Separate what is shown from what is assumed. Do not write "glitch".

## Impact

Which notes, requirements and [[Milestones]] it reaches, with dates before and after.

## Asks

Numbered. Who must do what, by when.

## Updates

Dated, one line each, newest last.

## Review

At least one reviewer from another team before the blocker drives a decision.
