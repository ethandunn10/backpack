# 🎒 Backpack

**The study buddy that remembers your homework.**

Built for the NXT Build Sprint for a friend who can't keep track of homework, studying, and time.

- 📸 Snap or paste homework. AI pulls out what's due, when, and what it covers.
- 🏠 **Today** shows tonight's plan, what's coming up, and a countdown to the next test.
- 🎯 **Tests** gives a day-by-day study plan up to test day.
- 🧠 **Practice quizzes are built from your own saved homework.** Each answer shows which homework it came from.

## How it works

- `index.html`: the whole app (no build step). Saves on the device.
- `api/ai.js`: a Vercel serverless function that talks to Claude. The API key stays on the server, and it only does two jobs (read homework, make a quiz), so it can't be used as a free chatbot.

## Deploy on Vercel

1. Import this repo in Vercel (no framework, no build command needed).
2. Add environment variables:
   - `ANTHROPIC_API_KEY`: your Anthropic API key
   - (optional) `ACCESS_CODE`: if set, people must enter this code to use the AI
   - (optional) `ANTHROPIC_MODEL`: defaults to `claude-haiku-5-5`
3. Deploy.

## Safety

- Optional access code for AI calls
- Rate limit per visitor, capped photo/text size, short AI answers, cheap model
- Set a low spend limit on the Anthropic account, and delete the key after the event
