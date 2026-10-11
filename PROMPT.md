```
OPEN MOTION · any Claude plan
Claude Motion is Team and Enterprise only. Build the same kind of animation
here: code that moves my text, charts, shapes and images, exported as MP4.
No video model. You can't watch video: look at frames, let the checks decide.

SETUP  git clone https://github.com/Archive228/open-motion motion
Use its scripts (needs Node 22+, Chrome and ffmpeg). Never rewrite them and
never loosen a check to make it pass.
NO TERMINAL (free plan)?  Give me index.html and content.json as files. I
run steps 4-5 myself and send you out/sheet.png and the check output.

1 ASK  Before you build, ask me: who will watch it, where it plays (16:9,
9:16, 4:5 or 1:1) and how long it runs. Use only the report, data and
images I attach. Never invent a number, a name or a quote.

2 CONTENT  Put every word, number, colour and scene length in content.json.
index.html fetches it into window.CONTENT (window.ready = that Promise) and
hard-codes none of them: one edit there is one change on screen.

3 BUILD  One index.html with window.DURATION, window.SIZE = [w, h] and
window.seek(t), a pure function of t. No CSS animations, timers, Date.now
or unseeded random. One idea per scene, 3-5 s each; numbers count up,
charts draw in. No text under 2% of the frame width. With a terminal,
read motion/example first for the contract; the look is yours.

4 LOOK  node motion/scripts/look.mjs . --sheet 12
Open out/sheet.png and say what you see in every frame. Fix what is cut
off, tiny, empty or standing still.

5 CHECK  node motion/scripts/render.mjs .
node motion/scripts/check.mjs .
Fix every FAIL by changing the animation, at most 3 rounds.

6 DELIVER  out/video.mp4 · content.json · EDIT.md: the 5 values I'm most
likely to change and where they live. Don't call it good; report what the
checks show.
```
