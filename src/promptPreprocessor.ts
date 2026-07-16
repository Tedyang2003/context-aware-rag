import {
    type ChatMessage,
    type PromptPreprocessorController,
} from "@lmstudio/sdk";
import { chooseContextInjectionStrategy } from "./strategy/chooseStrategy";
import { prepareDocumentContextInjection } from "./strategy/injectFullContent";
import { prepareRetrievalResultsContextInjection } from "./retrieval/prepareRetrieval";


// Main entry point for the plugin's prompt preprocessor
export async function preprocess(ctl: PromptPreprocessorController, userMessage: ChatMessage) {
    
    const ragStatus = ctl.createStatus({ status: "loading", text: `Starting Rag System....` });

    const userPrompt = userMessage.getText();
    const history = await ctl.pullHistory();
    history.append(userMessage);

    // Get Files that are not images
    const newFiles = userMessage.getFiles(ctl.client).filter(f => f.type !== "image");
    const files = history.getAllFiles(ctl.client).filter(f => f.type !== "image");

    ragStatus.setState({ status: "done", text: `Successfully Started Rag System` });

    // If there are files in the current message, choose a strategy for context injection
    if (newFiles.length > 0) {
        const strategy = await chooseContextInjectionStrategy(ctl, userPrompt, newFiles);

        // Inject full content as is
        if (strategy === "inject-full-content") {
            return await prepareDocumentContextInjection(ctl, userMessage);

        // Conduct RAG Retrieval
        } else if (strategy === "retrieval") {
            userMessage.consumeFiles(ctl.client, f => f.type !== "image");
            return await prepareRetrievalResultsContextInjection(ctl, userPrompt, files);
        }

    // For files that live in history, strip them from the userMessage and conduct RAG Retrieval
    } else if (files.length > 0) {
        // These files live on earlier messages, not userMessage — strip from history
        for (const historyMessage of history.getMessagesArray()) {
            historyMessage.consumeFiles(ctl.client, f => f.type !== "image");
        }
        return await prepareRetrievalResultsContextInjection(ctl, userPrompt, files);
    }
    
    // Return message as is if no files are present in the current message or history
    return userMessage;
}
