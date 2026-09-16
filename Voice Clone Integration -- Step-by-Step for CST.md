
# Voice Clone Integration into CST -- Step-by-Step

**For:** <@U0AC6RFNP3P>
**Source debrief:** <@U0AD1V1D65N>, voice clone / ElevenLabs

First -- a real thank you. <@U0AC6RFNP3P> has already taken CST from rough idea to a deployed, documented, contract-level system (Twilio ingress, signature verification, registry, identity/roles, step-up, intent routing, BHARAG connector, outbound queue, delivery callbacks, transcripts, alert audit log, fail-closed rules -- all live, with Swagger docs and env vars in Bitwarden). This voice-clone work is not a new product bolted on the side -- it's one more front door on the orchestrator you've already built. Genuinely strong pace, especially with the timeline pressure.

## What the voice clone actually is

- A clone of Jason's voice, hosted on **Jason's own ElevenLabs account**.
- That ElevenLabs account is the single source of truth for the voice, the `voice_id`, and any future regenerations or quality passes.
- **No second copy of the clone lives in the CST stack.** If the voice needs to change, it changes on ElevenLabs first -- never locally.

## Step-by-step integration into CST

**1. Add a voice pointer to the registry, not the clone itself**
- For each CST system allowed to speak (starting with vFarm CS), add a pointer entry alongside the existing `system_id` / `tenant_id` / `workspace_id` / `phone_numbers` / `bharag_workspace_key` fields:
  - ElevenLabs `voice_id`
  - the credentials used to render it
- The clone stays on Jason's account. CST only ever stores the pointer.

**2. Keep the existing authorization chain in front of voice**
- CST still owns identity, roles, step-up, and intent routing -- exactly as it does for SMS today.
- Only *after* an authorized, BHARAG-backed answer exists should CST synthesize it through ElevenLabs.
- Deliver on a voice lane (inbound call / IVR prompt / spoken callback). SMS stays SMS -- voice is a second front door on the same orchestrator, not a separate app.

**3. Apply the same fail-closed rule to voice as to text**
- If CST would refuse to send the text version of an answer, it must also refuse to speak it.
- Missing clone config, missing `voice_id`, or an ElevenLabs failure should **drop the spoken turn** -- never fall back to a generic/substitute voice.

**4. Wire voice renders into the existing audit and health surfaces**
- Each TTS render is a delivery event, tagged the same way SMS events are:
  - system/tenant
  - conversation + `message_id` / `correlation_id`
  - final status (`synthesized` / `sent` / `failed`)
  - error codes
- Transcripts stay attached to the conversation; the rendered audio is just another outbound artifact tied to that same thread and to `alert_audit_log`.

**5. Give Destiny a voice-lane health signal to compute from**
- Suggested signal: "clone configured + at least one successful spoken delivery in the last 24h."
- If that signal is missing, CST should stay SMS-only, and NS/RT should not route front-line voice traffic.

## Bottom line

- **Jason's ElevenLabs account** owns the clone.
- **CST** owns routing, identity, answers, delivery, and audit -- for voice exactly as it already does for SMS.
- This gets a real voice lane on the Customer Service Twin without standing up a separate voice product on the side.

**Next suggested step:** <@U0AD1V1D65N> offered to sit with <@U0AC6RFNP3P> and <@U0AEW3TBYH1> directly on the exact registry fields if this is going on the vFarm CS Twin v1 gate -- worth taking him up on that before locking the schema.
