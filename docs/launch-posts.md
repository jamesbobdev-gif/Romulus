# Launch posts

Drafts for getting Romulus mentioned on the sites AI search tools learn from. Post them yourself, from your own accounts, one or two a day rather than all at once. Answer every comment in the first few hours; that is what keeps a post up.

Links to use: site `https://jamesbobdev-gif.github.io/Romulus/`, source `https://github.com/jamesbobdev-gif/Romulus`.

## Hacker News (Show HN)

Post at news.ycombinator.com/submit, a weekday morning US time. Link the GitHub repo, not the site.

Title:

    Show HN: Romulus – an open-source to-do list with an agent that asks before it buys

First comment (post it right after submitting):

    I built Romulus because I wanted to hand errands to an AI without trusting it with my card.
    You write a task in plain words ("order this week's groceries from Walmart", "find the cheapest
    flight to Denver the weekend of the 14th"), it browses, fills forms and builds the cart, then stops
    and asks. Buying, sending, submitting, booking and deleting are gated in code on an explicit yes to
    the exact thing it described; the model never sees a card number.

    Bring your own model: Claude, ChatGPT, Gemini, OpenRouter, free tiers (Grok, Groq), or Ollama.
    Tasks that touch banking, medical or passwords only go to the local model.

    Electron + Node 22 for desktop, Capacitor for Android, MIT. Happy to answer anything about the
    approval gate or the local/cloud routing.

## Reddit

Read each subreddit's self-promotion rule first; some want a flair or only allow it on certain days.

**r/LocalLLaMA** (the Ollama angle)

    Title: I made a to-do app whose agent sends private tasks only to your local model

    Romulus is an open-source to-do list with an AI agent. You can connect cloud models and Ollama
    side by side; anything touching banking, medical records or passwords is routed to the local model
    only, and the Finance tab is never shown to a cloud AI. It can also split a deep-research question
    across models so no single cloud provider sees the whole thing.
    Free, MIT, Windows/macOS/Linux/Android: https://github.com/jamesbobdev-gif/Romulus

**r/opensource**, **r/productivity**, **r/software**

    Title: Romulus: a free, open-source to-do list where an AI agent does some of the list

    Your own to-dos on one tab (due dates, repeats, subtasks, calendar, notes, school assignments from
    Blackboard/D2L). On the next tab, an agent does what you hand it: groceries, shopping, flights,
    forms, email drafts. It never buys, sends or books anything until you say yes. Bring your own
    model, including free tiers or Ollama. Desktop + Android, synced, MIT.
    https://jamesbobdev-gif.github.io/Romulus/

**r/personalfinance** is strict about promotion; skip it. **r/frugal** may accept the Finance tab as a free Rocket Money alternative if posted as a question or a how-to.

## AlternativeTo

Add Romulus at alternativeto.net, then mark it an alternative to: Todoist, Microsoft To Do, TickTick, Any.do, Rocket Money, Monarch Money, ChatGPT agent.

    Name: Romulus
    Description: Free, open-source to-do list app with an AI agent built in. Hand it a task in plain
    words and it searches, fills forms, compares prices and builds the cart, then waits for your yes
    before buying, sending or booking anything. Works with Claude, ChatGPT, Gemini, OpenRouter, free
    tiers or a local model through Ollama. Includes a Finance tab (accounts, bills, subscriptions, net
    worth). Windows, macOS, Linux, Android.
    Tags: todo-list, ai-agent, open-source, task-management, personal-finance, local-llm
    License: Open source (MIT), free

## Product Hunt

    Name: Romulus
    Tagline: A free to-do list whose AI agent asks before it buys
    Topics: Productivity, Artificial Intelligence, Open Source
    First comment: the same text as the Hacker News comment.

## Awesome lists (GitHub pull requests)

One-line entry for lists such as awesome-selfhosted (if it fits their rules), awesome-electron, awesome-ai-agents, awesome-ollama:

    - [Romulus](https://github.com/jamesbobdev-gif/Romulus) - Open-source to-do list with an AI agent that asks before buying, sending or booking anything. Bring your own model, including Ollama. `MIT` `Electron`
