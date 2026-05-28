// --- Video Analyzer Proxy v2 (Multi-frame + Transcription) ---

// Increase body size limit for video audio uploads
// NOTE: Add this BEFORE the route if not already in server.js:
// app.use(express.json({ limit: '50mb' }));

app.post('/api/analyze-media', async (req, res) => {
  try {
    const { frames, imageBase64, mediaType, address, notes, mimeType, transcript, roomLabel } = req.body;

    const mediaTypeLabel = {
      maintenance: 'maintenance issue documentation',
      inspection: 'property inspection / walkthrough',
      'move-in': 'move-in condition documentation',
      'move-out': 'move-out condition documentation'
    }[mediaType] || mediaType;

    const contextNote = notes ? `\nProperty manager notes: ${notes}` : '';
    const addrNote = address ? `\nProperty: ${address}` : '';
    const roomNote = roomLabel ? `\nRoom/Area: ${roomLabel}` : '';
    const transcriptNote = transcript ? `\n\nAUDIO TRANSCRIPT FROM VIDEO (the inspector/PM said this while recording):\n"${transcript}"\n\nIMPORTANT: The transcript contains critical observations spoken by the inspector. Extract EVERY issue, damage item, and observation mentioned verbally — these are often the most important findings. Cross-reference what is spoken with what is visible in the frames.` : '';

    const prompt = `You are a senior property inspector AI for Aloe Property Management in the Phoenix metro area (Arizona). You are analyzing ${frames ? frames.length + ' frames from a video' : 'a photo'} showing a ${mediaTypeLabel}.${addrNote}${roomNote}${contextNote}${transcriptNote}

INSPECTION INSTRUCTIONS:
Examine every frame carefully. Look for ALL of the following in every frame:
- Paint condition (scuffs, marks, peeling, discoloration, nail holes, patching needed, full repaint needed)
- Flooring condition (carpet stains, tears, pet damage, tile cracks, vinyl damage, needs replacement vs cleaning)
- Walls and baseboards (damage, water stains, mold, pet damage, scratches)
- Ceiling condition (stains, cracks, texture damage, fan/light condition)
- Fixtures and hardware (outlet covers, light switches, door handles, hinges, towel bars)
- Window coverings (blinds condition — vertical, horizontal, missing slats, broken)
- Doors (condition, operation, damage, stops)
- Appliances (visible condition, age, damage)
- Plumbing fixtures (faucets, toilets, sinks, tubs — condition, leaks, caulking)
- HVAC (vents, filters, thermostat visible condition)
- Cleaning level (overall cleanliness, grease, grime, cobwebs, debris)
- Odor evidence (staining patterns suggesting pet urine, smoke damage, mold — visible indicators)
- Safety issues (missing covers, exposed wiring, trip hazards, smoke detectors)
- Cabinets and countertops (condition, hardware, damage)
- Exterior if visible (siding, patio, landscaping, fencing)

BE EXHAUSTIVE. A good inspection catches 15-30 items. Missing issues costs the property manager money.

Respond ONLY with a valid JSON object (no markdown, no backticks, no extra text):
{
  "overall_condition_score": 1-10,
  "overall_summary": "3-4 sentence overview of the property condition",
  "categories": [
    {
      "category": "Paint",
      "severity": "good|fair|poor|critical",
      "findings": "Detailed description of what you see",
      "action_needed": "Specific action required",
      "estimated_scope": "Touch-up|Partial|Full replacement",
      "vendor_type": "Painter|Handyman|etc"
    }
  ],
  "transcript_issues": [
    {
      "spoken_observation": "What the inspector said",
      "category": "Which category this falls under",
      "action_needed": "What needs to be done"
    }
  ],
  "urgent_items": ["List of items needing immediate attention"],
  "vendor_summary": [
    {
      "vendor_type": "e.g. Painter",
      "scope": "Brief scope description",
      "priority": "high|medium|low"
    }
  ],
  "turnover_estimate": "Light|Standard|Heavy|Full renovation",
  "chargeback_items": ["Items that could be charged back to tenant vs normal wear"],
  "additional_notes": "Any other observations"
}

Include ALL categories where you find issues — do not skip categories. If a category looks fine, still include it with severity "good". For move-out inspections, specifically flag tenant damage vs normal wear and tear.`;

    // Build the messages content array
    const contentParts = [];

    if (frames && frames.length > 0) {
      // Multi-frame analysis
      frames.forEach((frame, i) => {
        contentParts.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: frame.base64 }
        });
        contentParts.push({
          type: 'text',
          text: `[Frame ${i + 1} of ${frames.length} — timestamp ${frame.timestamp || 'unknown'}]`
        });
      });
    } else if (imageBase64) {
      // Single image analysis
      contentParts.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 }
      });
    }

    contentParts.push({ type: 'text', text: prompt });

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
        messages: [{ role: 'user', content: contentParts }]
      })
    });

    const data = await response.json();
    
    if (data.error) {
      console.error('Anthropic API error:', data.error);
      return res.status(500).json({ error: data.error.message || 'AI analysis failed' });
    }

    const text = data.content?.map(b => b.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    console.error('analyze-media error:', err);
    res.status(500).json({ error: err.message });
  }
});
// --- End Video Analyzer Proxy v2 ---
