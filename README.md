# Customer Service Twin (`bha-cst`)

Multi-tenant Customer Service Twin system. System #1 is vFarm.

## System Boundaries
`bha-cst` owns the **CONVERSATION** boundary:
- SMS transport (Twilio)
- Inbound/outbound message transport
- Transcripts and message history
- Transport queues (`messages_in`, `messages_out`)
- Routing rules per system
- Systems registry
- Customer conversations

### External Subsystems (NOT duplicated in CST)
- **Incidents**: Filed into BHARAG `incidents.v0` (`subsystem=CUSTOMER_TWIN`, `engine=VFARM`).
- **Identity**: Phone to customer mapping resolved through vFarm Customer Registry.
- **Knowledge**: Resolved via BHARAG RAG ask API.
- **Media**: Signed URLs via Media Server.

## Architecture & Documentation
- [System Architecture & Implementation Guide](docs/system-architecture-and-guide.md)
- [Tenant Isolation Guide](docs/tenant-isolation-guide.md)
- [Architecture Overview](docs/architecture.md)

## Getting Started

```bash
# Install dependencies
npm install

# Run type check
npm run typecheck

# Run tests
npm test
```
