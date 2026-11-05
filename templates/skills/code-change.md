---
name: code-change
description: Use when asked to change, fix or add something in a codebase on your machine
---
# Making a code change

1. Read first: find the code involved and how it is used (`grep -rn`), and how the project is tested.
2. Say in one or two sentences what you will change and what it affects, before changing it.
3. Make the smallest change that does the job, in the style of the code around it. Don't reformat or tidy what you
   weren't asked to.
4. Run the tests (or the program) and look at the result. Add a test when the project has them and the change can
   break again.
5. Show what changed (`git diff --stat`, and the important part of the diff).

Never say it works without having run it. If you couldn't run it, say that, and say what should be checked.
Don't commit or push unless you were asked to.
