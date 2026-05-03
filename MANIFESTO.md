# The Attention Layer

*By Matt Walker · May 2026 · v1.1*

The last decade gave us infinite storage and instant retrieval. We have
more of our own data than we have ever had. We use less of it than ever.
And the systems we hand that data to — the language models that can
reason about almost anything — can't actually remember it across the
conversations we have with them.

Walk through the apps on a competent person's phone and you'll find a
strange thing. Notes from three years ago they cannot find. A reminder
system they have given up on. An inbox they declared bankruptcy on
twice. A calendar that reflects only what other people have asked of
them. Three different to-do apps, none of them current. A journal they
kept for eleven days. The information is all there. The system is not.

The problem is not that we lack tools. The problem is that all of them
are waiting for us. They store what we file, retrieve what we search,
generate what we ask. They are responsive in the literal sense — they
respond. None of them notice. None of them hold a model of what matters
to a particular person at a particular time and act on it without being
asked.

That layer — the one that pays attention so the human doesn't have to —
is the missing piece. I think of it as the attention layer, and I think
it is the most important consumer software primitive of the next decade.

## What is missing, exactly

Consider what a thoughtful human assistant does for the person they
work for. They don't store information. They notice it. They notice
that the cover letter is due Friday and the user keeps deferring it.
They notice that two weeks have passed without a follow-up to the
school. They notice that the user mentioned feeling stretched in three
different conversations and brings it up gently, once, in private.
They keep a continuously updated model of what is alive, what is
unresolved, what is quiet but not dead, what matters this week versus
what mattered last quarter.

No software does this. Not Notion. Not Obsidian. Not the personal CRMs.
Not the AI chatbots. Not the meeting transcribers. Each captures a
fragment — relationships, notes, conversations, calendars — but none of
them holds the whole picture of a person's operational life and acts
on it.

Two technical primitives are missing, and the work of building this
layer requires building both. The first is memory that actually
persists with salience, consolidation, and provenance — not the shallow
"memory features" Claude and GPT have started bolting onto chat
interfaces, which forget what matters and remember what doesn't. The
second is attention itself — the layer that uses that memory to notice
without being asked, to hold the model of what matters, to act on it on
its own clock. Inference is cheap. Embeddings are commoditized. Native
push is solved. What's missing is the substrate underneath the
substrate — and the willingness to build it as the foundation, instead
of bolting AI features onto an existing app shape.

## What an attention layer looks like

If the attention is the product, then the home screen is what the
system has noticed. Not a list of tasks the user filed. Not a graph of
notes the user wrote. A short, generated paragraph in the system's own
voice about what matters to this person right now, drawn from
everything they have told it across all the time they have been using
it.

> This week, you're focused on: the cover letter (due Friday), Megan's
> IEP meeting Thursday, the basement radon retest. Open with Susanna:
> the bathroom tile decision, the weekend with her parents. Quiet but
> not forgotten: the Third Period Labs outreach you captured 17 days
> ago.

The user did not write that. The user typed eight scattered things over
the last two weeks. The system kept a model. The model is the product.

The conversation is a continuous thread, not a chat with discrete
sessions. Memory carries across days. When the system mentions
something from last Tuesday, it says so, and the source is tappable.
The notifications, when they come — and they mostly do not come — are
about specific things, with specific referents, that the user would
want to know about. No streaks. No engagement loops. No marketing.

This is not a productivity app. Productivity apps make the user better
at managing a system. Attention layers remove the system entirely.

## Why now

Three things are simultaneously true for the first time. Inference is
cheap enough to run continuously per user. Models are good enough at
reasoning over personal context to be trusted with the synthesis. And
the consumer is exhausted enough by the proliferation of single-purpose
apps to be ready for something whose explicit promise is *you don't
have to manage this.*

The attention layer is what gets built when a developer takes those
three facts seriously instead of shipping another wrapper around a
chat completion endpoint — and is willing to build the missing memory
substrate underneath it, rather than waiting for the major labs to
provide it as infrastructure.

## What I'm building

[Lila](https://lila.surf) is the first attention layer — an iOS client
whose entire surface is the system's continuously updated model of what
matters in your life. It is built on
[lila-core](https://github.com/my92agsr/lila-core), an open-source
runtime that builds both missing primitives: a memory architecture with
salience scoring, source-ID receipts, and nightly LLM-driven
consolidation that produces a generative working-memory layer; and the
attention layer on top of it — scheduled cognition, proactive reach-out,
the model itself as the product. The runtime is the substrate; the iOS
app is the surface; the category, I think, is new.

The thesis is not that the world needs another note app, or another
assistant, or another AI feature. The thesis is that two layers between
a person and the rest of their tools — the layer that holds the model
of what they care about, and the layer that acts on it without being
asked — have been missing this whole time, and it is finally possible
to build both.

**The category is new. The need has been there the whole time.**

— [Matt](https://mattwalker.dev)
