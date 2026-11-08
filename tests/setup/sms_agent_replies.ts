// The older SMS suites exercise the Core Engine reply path, which is off in
// production since 8 Nov 2026 (971 texts are START, HELP and STOP only; see
// engine/src/interfaces/sms/text_policy.ts). They keep running against it with
// the switch on. tests/interfaces/sms_calls_only.test.ts covers the default.
if (process.env.CST_SMS_AGENT_REPLIES === undefined) process.env.CST_SMS_AGENT_REPLIES = 'on';
if (process.env.CST_SMS_KEYWORD_REPLIES === undefined) process.env.CST_SMS_KEYWORD_REPLIES = 'app';
