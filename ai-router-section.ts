
// ============================================================================
// AI ROUTER — LLM service layer (Anthropic Claude)
// ============================================================================
const aiRouter = router({
  // Health check — verify Anthropic API connectivity (public, no auth needed)
  health: publicProcedure.query(async () => {
    return healthCheck();
  }),

  // Generate a customer-facing message (Communication Agent)
  generateMessage: protectedProcedure
    .input(
      z.object({
        contactName: z.string().min(1),
        objective: z.string().min(1),
        context: z.string().min(1),
        channel: z.enum(["email", "sms", "whatsapp"]),
        tone: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      return generateMessage(input);
    }),

  // Classify inbound message intent (Ingestion Service)
  classifyIntent: protectedProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return classifyIntent(input.text);
    }),

  // Score confidence for a proposed action (Decision Engine)
  scoreConfidence: protectedProcedure
    .input(
      z.object({
        contactData: z.string().min(1),
        objective: z.string().min(1),
        proposedAction: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      return scoreConfidence(input);
    }),

  // Select best strategy for a contact (Decision Engine)
  selectStrategy: protectedProcedure
    .input(
      z.object({
        contactContext: z.string().min(1),
        objectiveGap: z.string().min(1),
        availableStrategies: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ input }) => {
      return selectStrategy(input);
    }),

  // Get available model info (public)
  models: publicProcedure.query(() => {
    return {
      sonnet: { id: MODELS.SONNET, use: "Strategy selection, message generation, Brain synthesis" },
      haiku: { id: MODELS.HAIKU, use: "Intent classification, confidence scoring, field mapping" },
    };
  }),
});
