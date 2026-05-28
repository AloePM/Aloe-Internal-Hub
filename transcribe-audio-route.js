// --- Audio Transcription Route ---
// Add this route alongside the analyze-media route in server.js
// Also update the body size limit: app.use(express.json({ limit: '50mb' }));

app.post('/api/transcribe-audio', async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) return res.json({ transcript: null });

    // Use Claude to transcribe - send audio as a document
    // Alternative: Use OpenAI Whisper API for better transcription
    // For now, we'll use a simple approach with Claude's capabilities
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'audio/wav', data: audioBase64 }
            },
            {
              type: 'text',
              text: 'Transcribe this audio recording from a property inspection. Write out everything the inspector says word for word. If there is no speech or the audio is too unclear, respond with just: NO_SPEECH_DETECTED'
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    
    if (text.includes('NO_SPEECH_DETECTED') || text.trim().length < 10) {
      return res.json({ transcript: null });
    }
    
    res.json({ transcript: text.trim() });
  } catch (err) {
    console.error('transcribe-audio error:', err);
    res.json({ transcript: null });
  }
});
// --- End Audio Transcription Route ---
