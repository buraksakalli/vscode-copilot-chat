/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '@vscode/prompt-tsx/dist/base/output/rawTypes';
import type { CancellationToken } from 'vscode';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { Emitter } from '../../../util/vs/base/common/event';
import { IntentParams, Source } from '../../chat/common/chatMLFetcher';
import { ChatLocation, ChatResponse } from '../../chat/common/commonTypes';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../networking/common/fetch';
import { Response } from '../../networking/common/fetcherService';
import { IChatEndpoint } from '../../networking/common/networking';
import { ChatCompletion } from '../../networking/common/openai';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService, TelemetryProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { IEndpointProvider } from '../common/endpointProvider';

/**
 * This endpoint represents the "Auto" model in the model picker.
 * It is just a shell class used to register with the `lm` API so it shows up in the model picker.
 * The actual model resolution is done in `src/extension/prompt/vscode-node/endpointProviderImpl.ts`.
 */
export class AutoChatEndpoint implements IChatEndpoint {
	public static readonly id = 'auto';
	private static _lastSelectedModelName: string = '';
	private static _onModelSelectionChanged = new Emitter<string>();
	private static _selectedModelName: string = '';
	private static _lastActualModelName: string = '';

	maxOutputTokens: number = 4096;
	model: string = AutoChatEndpoint.id;
	supportsToolCalls: boolean = true;
	supportsVision: boolean = true;
	supportsPrediction: boolean = true;
	showInModelPicker: boolean = true;
	isPremium?: boolean | undefined = false;
	multiplier?: number | undefined = undefined;
	restrictedToSkus?: string[] | undefined = undefined;
	isDefault: boolean = false;
	isFallback: boolean = false;
	policy: 'enabled' | { terms: string } = 'enabled';
	urlOrRequestMetadata: string = '';
	modelMaxPromptTokens: number = 64000;
	version: string = 'auto';
	family: string = 'auto';
	tokenizer: TokenizerType = TokenizerType.O200K;

	// Dynamic name based on last selected model
	get name(): string {
		return AutoChatEndpoint._selectedModelName || 'Auto';
	}

	// Static methods to manage the selected model display
	/**
	 * Updates the selected model name for the Auto endpoint display
	 * @param modelName The friendly name of the model that was selected
	 */
	public static updateSelectedModel(modelName: string): void {
		const newName = `Auto (${modelName})`;
		if (AutoChatEndpoint._selectedModelName !== newName) {
			AutoChatEndpoint._selectedModelName = newName;
			AutoChatEndpoint._lastActualModelName = modelName;
			AutoChatEndpoint._onModelSelectionChanged.fire(modelName);
		}
	}

	/**
	 * Gets the last selected model name for display purposes
	 * @returns The friendly name of the last selected model
	 */
	public static getLastSelectedModelName(): string {
		return AutoChatEndpoint._lastActualModelName || 'Auto';
	}

	/**
	 * Event fired when the Auto model selection changes
	 */
	public static get onModelSelectionChanged() {
		return AutoChatEndpoint._onModelSelectionChanged.event;
	}

	constructor(
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@ITokenizerProvider private readonly _tokenizerProvider: ITokenizerProvider,
		@IExperimentationService private readonly _expService: IExperimentationService,
	) {
	}

	processResponseFromChatEndpoint(telemetryService: ITelemetryService, logService: ILogService, response: Response, expectedNumChoices: number, finishCallback: FinishedCallback, telemetryData: TelemetryData, cancellationToken?: CancellationToken): Promise<AsyncIterableObject<ChatCompletion>> {
		throw new Error('Method not implemented.');
	}
	acceptChatPolicy(): Promise<boolean> {
		throw new Error('Method not implemented.');
	}
	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		throw new Error('Method not implemented.');
	}
	acquireTokenizer(): ITokenizer {
		return this._tokenizerProvider.acquireTokenizer({ tokenizer: TokenizerType.O200K });
	}

	async makeChatRequest(debugName: string, messages: ChatMessage[], finishedCb: FinishedCallback | undefined, token: CancellationToken, location: ChatLocation, source?: Source, requestOptions?: Omit<OptionalChatRequestParams, 'n'>, userInitiatedRequest?: boolean, telemetryProperties?: TelemetryProperties, intentParams?: IntentParams): Promise<ChatResponse> {
		// This is only ever called from LM chat extensions.
		//  Copilot Chat 1st party requests instead get the endpoint much earlier and never call `makeChatRequest` on this endpoint but instead the actual one
		// What copilot Chat does is more correct, but it's difficult to do this in the LM API
		const endpoint = await resolveAutoChatEndpoint(this._endpointProvider, this._expService, undefined);
		return endpoint.makeChatRequest(
			debugName,
			messages,
			finishedCb,
			token,
			location,
			source,
			requestOptions,
			userInitiatedRequest,
			telemetryProperties,
			intentParams,
		);
	}
}

/**
 * Checks if the auto chat mode is enabled.
 * @param expService The experimentation service to use to check if the auto mode is enabled
 * @returns True if the auto mode is enabled, false otherwise
 */
export function isAutoModeEnabled(expService: IExperimentationService): boolean {
	// Always enable intelligent auto mode
	return true;
}

/**
 * Resolves the auto chat endpoint to the most suitable backing chat endpoint based on intelligent prompt analysis.
 * @param endpointProvider The endpoint provider to use to get the chat endpoints
 * @param expService The experimentation service (not used in intelligent mode)
 * @param userPrompt The user's prompt to analyze for optimal model selection
 * @returns The endpoint that should be used for the auto chat model
 */
export async function resolveAutoChatEndpoint(
	endpointProvider: IEndpointProvider,
	expService: IExperimentationService,
	userPrompt: string | undefined,
): Promise<IChatEndpoint> {
	const allEndpoints = await endpointProvider.getAllChatEndpoints();

	// If no prompt provided, default to GPT-4o or GPT-4.1
	if (!userPrompt || userPrompt.trim().length === 0) {
		const defaultEndpoint = allEndpoints.find(e => e.model === 'gpt-4o') ||
			allEndpoints.find(e => e.model === 'gpt-4.1') ||
			allEndpoints.find(e => e.model === 'gpt-4') ||
			await endpointProvider.getChatEndpoint('copilot-base');
		// Update the Auto display name to show the default model
		AutoChatEndpoint.updateSelectedModel(defaultEndpoint.name);
		return defaultEndpoint;
	}

	// Analyze prompt for intelligent model selection
	const promptLower = userPrompt.toLowerCase();

	// Task type detection patterns
	const isComplexReasoning = /\b(analy[sz]e|reasoning|logic|problem[\s-]solving|strategy|architecture|design pattern|trade[\s-]off|pros and cons|compare|evaluate|assessment|complex|difficult|challenging)\b/.test(promptLower);
	const isCodeGeneration = /\b(generat|creat|writ|build|implement|develop|code|function|class|component|api|endpoint|algorithm|snippet|example)\b/.test(promptLower);
	const isCodeReview = /\b(review|check|improv|optimi[sz]e|refactor|fix|debug|error|bug|issue|problem|suggestion|feedback|critique)\b/.test(promptLower);
	const isCreativeWriting = /\b(story|creative|poem|article|blog|content|marketing|writing|narrative|fiction|essay|novel)\b/.test(promptLower);
	const isVisionTask = /\b(image|photo|picture|visual|diagram|chart|screenshot|analysis)\b/.test(promptLower);
	const isLongContext = userPrompt.length > 8000; // Long prompts need high-context models

	console.log(`[AutoChatEndpoint] Prompt analysis: complex=${isComplexReasoning}, code=${isCodeGeneration}, review=${isCodeReview}, creative=${isCreativeWriting}, vision=${isVisionTask}, long=${isLongContext}`);

	let preferredModels: string[] = [];

	// Model selection logic based on task type
	if (isComplexReasoning) {
		preferredModels = ['o1', 'o1-mini', 'gpt-4', 'gpt-4o', 'claude-sonnet-4'];
	} else if (isCodeGeneration) {
		preferredModels = ['claude-sonnet-4', 'claude-sonnet-3.7', 'gpt-4o', 'gpt-4'];
	} else if (isCodeReview) {
		preferredModels = ['gpt-4', 'gpt-4o', 'claude-sonnet-4'];
	} else if (isCreativeWriting) {
		preferredModels = ['claude-sonnet-4', 'claude-sonnet-3.7', 'claude-sonnet-3.5'];
	} else if (isVisionTask) {
		// Filter to vision-capable models
		const visionModels = allEndpoints.filter(e => e.supportsVision).map(e => e.model);
		preferredModels = visionModels.length > 0 ? visionModels : ['gpt-4o', 'claude-sonnet-4'];
	} else if (isLongContext) {
		// Filter to high-context models (>32k tokens)
		const highContextModels = allEndpoints.filter(e => e.modelMaxPromptTokens > 32000).map(e => e.model);
		preferredModels = highContextModels.length > 0 ? highContextModels : ['gpt-4o', 'claude-sonnet-4'];
	} else {
		// Default case - general queries
		preferredModels = ['gpt-4o', 'gpt-4.1', 'gpt-4'];
	}

	// Find the first available preferred model
	for (const modelId of preferredModels) {
		const endpoint = allEndpoints.find(e => e.model === modelId || e.model === `copilot-${modelId}`);
		if (endpoint) {
			console.log(`[AutoChatEndpoint] Selected model: ${endpoint.model} for task type analysis`);
			// Update the Auto display name to show the selected model
			AutoChatEndpoint.updateSelectedModel(endpoint.name);
			return endpoint;
		}
	}

	// Fallback to default models (GPT-4o > GPT-4.1 > GPT-4 > copilot-base)
	console.log(`[AutoChatEndpoint] No preferred models found, using fallback`);
	const fallbackEndpoint = allEndpoints.find(e => e.model === 'gpt-4o') ||
		allEndpoints.find(e => e.model === 'gpt-4.1') ||
		allEndpoints.find(e => e.model === 'gpt-4') ||
		await endpointProvider.getChatEndpoint('copilot-base');

	console.log(`[AutoChatEndpoint] Final selected model: ${fallbackEndpoint.model}`);
	// Update the Auto display name to show the fallback model
	AutoChatEndpoint.updateSelectedModel(fallbackEndpoint.name);
	return fallbackEndpoint;
}