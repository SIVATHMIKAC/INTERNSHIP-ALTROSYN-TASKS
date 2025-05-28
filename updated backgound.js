// background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handleRequest = async () => {
    try {
      if (request.action === "generateComment") {
        const result = await handleCommentGeneration(request);
        sendResponse(result);
      } else if (request.action === "generateMessage") {
        const result = await handleMessageGeneration(request);
        sendResponse(result);
      } else if (request.action === "generatePersonalDm") {
        const result = await getPersonalizedDm(request);
        sendResponse(result)
      } else if (request.action === "logError") {
        console.error('Client Error:', request.error);
        sendResponse({ status: 'logged' });
      }
    } catch (error) {
      console.error('Background Error:', error);
      sendResponse({
        error: error.message || 'An unexpected error occurred',
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
      });
    }
  };

  handleRequest();
  return true; // Keep message port open for async response
});

// ========== COMMENT GENERATION ========== //
async function handleCommentGeneration(request) {
  const { postText, config, aiSettings } = request;

  // Validate inputs
  if (!postText?.trim()) throw new Error('Post text is required');
  
  // Get system prompt from config or fall back to user profile
  const systemPrompt = await getSystemPrompt(config);
  if (!systemPrompt) throw new Error('System prompt is required and no user profile found');

  if (!aiSettings?.apiKey || !aiSettings?.apiUrl) {
    throw new Error('AI API key and URL are required for comment generation');
  }

  try {
    return await generateWithCustomAI(postText, {...config, systemPrompt}, aiSettings);
  } catch (error) {
    console.error('Comment Generation Failed:', error);
    throw new Error(`Failed to generate comment: ${error.message}`);
  }
}

// ========== FIRST MESSAGE GENERATION ========== //
async function handleMessageGeneration(request) {
  const { profileData, config, aiSettings } = request;

  if (!profileData) throw new Error('Profile data is required');
  
  // Get system prompt from config or fall back to user profile
  const systemPrompt = await getSystemPrompt(config);
  if (!systemPrompt) throw new Error('System prompt is required and no user profile found');

  try {
    if (aiSettings?.apiKey && aiSettings?.apiUrl) {
      return await generateMessageWithCustomAI(profileData, {...config, systemPrompt}, aiSettings);
    }
  } catch (error) {
    console.error('Message Generation Failed:', error);
    throw new Error(`Failed to generate message: ${error.message}`);
  }
}

// ========== DM GENERATION ========== //
async function getPersonalizedDm(request) {
  const { participantData, config, aiSettings } = request;

  // Validate inputs
  if (!participantData?.participantName) throw new Error('Participant data is required');
  
  // Get system prompt from config or fall back to user profile
  const systemPrompt = await getSystemPrompt(config);
  if (!systemPrompt) throw new Error('System prompt is required and no user profile found');

  try {
    if (aiSettings?.apiKey && aiSettings?.apiUrl) {
      return await generateDmWithCustomAI(participantData, {...config, systemPrompt}, aiSettings);
    }
  } catch (error) {
    console.error('DM Generation Failed:', error);
    throw new Error(`Failed to generate DM: ${error.message}`);
  }
}

// ========== AI GENERATION FUNCTIONS ========== //
async function generateWithCustomAI(postText, config, aiSettings) {
  const messages = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: `${config.userPrompt || 'Respond to this post:'}\n\n${postText}` }
  ];

  const payload = {
    model: aiSettings.model || "gpt-3.5-turbo",
    messages,
    temperature: config.temperature || 0.7,
    max_tokens: config.maxTokens || 500
  };

  const response = await fetchWithTimeout(aiSettings.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiSettings.apiKey}`,
      'X-Request-Source': 'linkedin-extension'
    },
    body: JSON.stringify(payload)
  }, 15000);

  const data = await response.json();

  if (!data.choices?.[0]?.message?.content) {
    throw new Error(data.error?.message || 'Invalid response format from AI');
  }

  return { comment: data.choices[0].message.content.trim() };
}

async function generateMessageWithCustomAI(profileData, config, aiSettings) {
  const messages = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: `${config.userPrompt}\n\n${JSON.stringify(profileData)}` }
  ];

  const payload = {
    model: aiSettings.model || "gpt-3.5-turbo",
    messages,
    temperature: config.temperature || 0.7,
    max_tokens: config.maxTokens || 1000
  };

  const response = await fetchWithTimeout(aiSettings.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiSettings.apiKey}`,
      'X-Request-Source': 'linkedin-extension'
    },
    body: JSON.stringify(payload)
  }, 15000);

  const data = await response.json();

  if (!data.choices?.[0]?.message?.content) {
    throw new Error(data.error?.message || 'Invalid response format from AI');
  }

  return { message: data.choices[0].message.content.trim() };
}

async function generateDmWithCustomAI(participantData, config, aiSettings) {
  const conversationContext = participantData.lastMessages
    ? participantData.lastMessages
      .map(msg => {
        const sender = msg.isCurrentUser
          ? 'Me'
          : (msg.sender || participantData.lastMessageSender || 'Them');
        return `${sender}: ${msg.message}`;
      })
      .join('\n')
    : 'No previous messages';

  const messages = [
    {
      role: "system",
      content: config.systemPrompt
    },
    {
      role: "user",
      content: `${config.userPrompt}\n\n` +
        `Recipient: ${participantData.participantName}\n` +
        `Replying to: ${participantData.lastMessageSender || 'N/A'}\n` +
        `Conversation Context:\n${conversationContext}`
    }
  ];

  const payload = {
    model: aiSettings.model || "gpt-3.5-turbo",
    messages,
    temperature: config.temperature || 0.7,
    max_tokens: config.maxTokens || 1000
  };

  const response = await fetchWithTimeout(aiSettings.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiSettings.apiKey}`,
      'X-Request-Source': 'linkedin-extension'
    },
    body: JSON.stringify(payload)
  }, 15000);

  const data = await response.json();

  if (!data.choices?.[0]?.message?.content) {
    throw new Error(data.error?.message || 'Invalid response format from AI');
  }

  return { message: data.choices[0].message.content.trim() };
}

// ========== SHARED UTILITIES ========== //
async function getSystemPrompt(config) {
  // If system prompt is provided in config, use it
  if (config?.systemPrompt?.trim()) {
    return config.systemPrompt;
  }
  
  // Otherwise try to get user profile from local storage
  try {
    const result = await chrome.storage.local.get(['userProfile']);
    if (result.userProfile) {
      // Create a system prompt based on the user's profile
      return `You are a professional assistant helping the following LinkedIn user compose messages. 
      Use their tone, style, and professional background when crafting responses.
      
      User Profile:
      - Name: ${result.userProfile.name || 'Not specified'}
      - Headline: ${result.userProfile.headline || 'Not specified'}
      - About: ${result.userProfile.about || 'Not specified'}
      - Experience: ${result.userProfile.experience?.join('\n- ') || 'Not specified'}
      
      Always maintain a professional tone appropriate for LinkedIn communications.`;
    }
  } catch (error) {
    console.error('Failed to get user profile from storage:', error);
  }
  
  return null;
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`${options.method || 'GET'} request to ${url} timed out`);
    }
    throw error;
  }
}

function logErrorToService(error) {
  if (process.env.NODE_ENV === 'production') {
    fetch('https://error-tracking-service.com/log', {
      method: 'POST',
      body: JSON.stringify({
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        version: chrome.runtime.getManifest().version
      })
    }).catch(e => console.error('Failed to log error:', e));
  }
}
