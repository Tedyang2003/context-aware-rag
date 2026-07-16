import {
    text,
    type Chat,
    type LLMDynamicHandle,
    type PromptPreprocessorController,
} from "@lmstudio/sdk";


async function getEffectiveContextFormatted(
    ctx: Chat,
    model: LLMDynamicHandle,
    ctl: PromptPreprocessorController,
) {
    try {
        return await model.applyPromptTemplate(ctx);
    } catch (e) {
        const hasAnyUserMessage = ctx.getMessagesArray().some(message => message.getRole() === "user");
        if (!hasAnyUserMessage) {
            const placeholderUserMessageContent = "?";
            ctl.debug(text`
        Failed to apply prompt template on context with no user messages. Retrying with placeholder
        user message.
      `);
            const measurementContext = ctx.withAppended("user", placeholderUserMessageContent);
            return await model.applyPromptTemplate(measurementContext);
        }
        throw e;
    }
}

export async function measureContextWindow(
    ctx: Chat,
    model: LLMDynamicHandle,
    ctl: PromptPreprocessorController,
) {
    const currentContextFormatted = await getEffectiveContextFormatted(ctx, model, ctl);
    const totalTokensInContext = await model.countTokens(currentContextFormatted);
    const modelContextLength = await model.getContextLength();
    const modelRemainingContextLength = modelContextLength - totalTokensInContext;
    const contextOccupiedPercent = (totalTokensInContext / modelContextLength) * 100;
    return {
        totalTokensInContext,
        modelContextLength,
        modelRemainingContextLength,
        contextOccupiedPercent,
    };
}
