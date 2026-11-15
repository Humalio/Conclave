---
owner: Case Command
status: active
depends_on: []
tags: [template]
---
# Capture template

Copy this note to start a new capture. Name it `CAP-NNN Short title`. Ask Wynn for the next number; numbers are never reused, including for captures that are cancelled. Every result in the vault traces to a capture ID (R11), so an unlabelled test is a test that did not happen.

Frontmatter: owner is the team that runs it; status starts at draft, then running, then closed (or paused). List in depends_on every note whose results you use: the drawing, the model, the earlier capture.

## Purpose

One paragraph. Which requirement or milestone this serves, and what a pass and a fail each lead to.

## Method

Five or six sentences: receiver chain (relay firmware or hand-clocked), dish and bay, what is transmitted and at what power, what is measured and at what rate, when the face is inspected, and the pass criterion. Write it so someone else could repeat it without asking you.

## Schedule

Table of blocks, with the condition (transmit power, temperature, message rate) for each, and the basis for that condition. If a block needs a waiver or a pending update, say which.

## Log

Terse, stand time, one line per event, no adjectives. Copy the important lines to the [[Listening log]].

## Result

Pass, fail, or pending, in the first line. Then numbers in a table, against the requirement.

## What it does not cover

Limits of the test. What a reader must not conclude from it.

## Data

Links to the raw files in Assets, and to the notes that use the result.
