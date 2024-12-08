import React, { useEffect, useRef, useCallback, useState } from 'react';
import { RealtimeClient } from '../lib/realtime-api-beta/index.js';
import { ItemType } from '../lib/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { instructions } from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';
import { X, Edit, Zap } from 'react-feather';
import { Button } from '../components/button/Button';
import './ConsolePage.scss';
import { SimliClient } from 'simli-client';
import simliLogo from '../assets/simli_small_logo.jpg';

const USE_LOCAL_RELAY_SERVER_URL: string | undefined = undefined;

interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: Record<string, unknown>;
}

function resampleAudioData(
  inputData: Int16Array,
  inputSampleRate: number,
  outputSampleRate: number
): Int16Array {
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(inputData.length / sampleRateRatio);
  const outputData = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * sampleRateRatio;
    const lowerIndex = Math.floor(sourceIndex);
    const upperIndex = Math.min(lowerIndex + 1, inputData.length - 1);
    const interpolation = sourceIndex - lowerIndex;
    outputData[i] =
      (1 - interpolation) * inputData[lowerIndex] +
      interpolation * inputData[upperIndex];
  }

  return outputData;
}

export function ConsolePage(): JSX.Element {
  const apiKey = USE_LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      USE_LOCAL_RELAY_SERVER_URL
        ? { url: USE_LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliClientRef = useRef<SimliClient | null>(null);
  const simliAudioBufferRef = useRef<Uint8Array[]>([]);

  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);

  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  const initializeAudioContext = useCallback(async () => {
    try {
      console.log('Initializing AudioContext...');
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('AudioContext not supported');
      }
      
      const context = new AudioContextClass();
      console.log('AudioContext created, state:', context.state);
      
      if (context.state === 'suspended') {
        console.log('Attempting to resume AudioContext...');
        await context.resume();
        console.log('AudioContext resumed, new state:', context.state);
      }
      
      setAudioContext(context);
      return context;
    } catch (error) {
      console.error('Failed to initialize AudioContext:', error);
      return null;
    }
  }, []);

  const isSimliDataChannelOpen = useCallback(() => {
    if (!simliClientRef.current) return false;
  
    const pc = (simliClientRef.current as any).pc as RTCPeerConnection | null;
    const dc = (simliClientRef.current as any).dc as RTCDataChannel | null;
  
    return pc !== null && pc.iceConnectionState === 'connected' && dc !== null && dc.readyState === 'open';
  }, []);
  
  const connectConversation = useCallback(async () => {
    console.log('Starting connection process...');
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;

    // Initialize audio context if not already initialized
    if (!audioContext) {
      console.log('No AudioContext found, initializing...');
      const context = await initializeAudioContext();
      if (!context) {
        console.error('Failed to initialize audio context');
        return;
      }
    } else {
      console.log('Existing AudioContext found, state:', audioContext.state);
      if (audioContext.state === 'suspended') {
        try {
          console.log('Attempting to resume existing AudioContext...');
          await audioContext.resume();
          console.log('AudioContext resumed successfully');
        } catch (error) {
          console.error('Failed to resume AudioContext:', error);
          return;
        }
      }
    }

    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());
  
    if (simliClientRef.current) {
      console.log('Starting Simli client...');
      simliClientRef.current.start();
      const audioData = new Uint8Array(6000).fill(0);
      simliClientRef.current.sendAudioData(audioData);
      console.log('Sent initial empty audio data to Simli');
    }
  
    console.log('Connecting to API...');
    await client.connect();
    console.log('API connected');

    console.log('Initializing audio recorder...');
    await wavRecorder.begin();
    console.log('Audio recorder initialized');

    console.log('Connecting stream player...');
    await wavStreamPlayerRef.current.connect();
    console.log('Stream player connected');
    
    if (client.getTurnDetectionType() === 'server_vad') {
      console.log('Starting recording with VAD...');
      await wavRecorder.record((data: { mono: any }) => client.appendInputAudio(data.mono));
      console.log('Recording started');
    }
  }, [audioContext, initializeAudioContext]);
  
  const changeVoiceType = useCallback(async () => {
    const client = clientRef.current;
    const allowedVoices: Array<'shimmer' | 'alloy' | 'echo'> = ['shimmer', 'alloy', 'echo'];
    const voice = process.env.REACT_APP_VOICE || 'shimmer';
    const validVoice = allowedVoices.includes(voice as 'shimmer' | 'alloy' | 'echo')
      ? (voice as 'shimmer' | 'alloy' | 'echo') 
      : 'shimmer';

    client.updateSession({
      voice: validVoice,
    });
  }, []);

  useEffect(() => {
    changeVoiceType();
  }, [changeVoiceType]);

  const disconnectConversation = useCallback(async () => {
    console.log('Starting disconnect process...');
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);

    const client = clientRef.current;
    client.disconnect();
    console.log('API client disconnected');

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();
    console.log('Audio recorder ended');

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
    console.log('Stream player interrupted');

    if (simliClientRef.current) {
      simliClientRef.current.close();
      console.log('Simli client closed');
    }

    // Clean up audio context
    if (audioContext) {
      try {
        await audioContext.close();
        console.log('AudioContext closed');
        setAudioContext(null);
      } catch (error) {
        console.error('Error closing AudioContext:', error);
      }
    }
  }, [audioContext]);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  const startRecording = async () => {
    console.log('Starting recording process...');
    if (!audioContext) {
      console.log('No AudioContext found, initializing...');
      await initializeAudioContext();
    } else if (audioContext.state === 'suspended') {
      console.log('AudioContext suspended, attempting to resume...');
      await audioContext.resume();
    }
    
    setIsRecording(true);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    
    console.log('Interrupting stream player...');
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      console.log('Canceling response...');
      await client.cancelResponse(trackId, offset);
    }
    
    console.log('Starting audio recording...');
    await wavRecorder.record((data: { mono: any }) => client.appendInputAudio(data.mono));
    console.log('Recording started');
  };

  const stopRecording = async () => {
    console.log('Stopping recording...');
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    console.log('Recording paused');
    client.createResponse();
    console.log('Response created');
  };

  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#0099ff',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayerRef.current.analyser
              ? wavStreamPlayerRef.current.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#009900',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  useEffect(() => {
    console.log('Initializing main component...');
    const client = clientRef.current;

    if (videoRef.current && audioRef.current) {
      const simliApiKey = process.env.REACT_APP_SIMLI_API_KEY;
      const simliFaceID = process.env.REACT_APP_SIMLI_FACE_ID;

      if (!simliApiKey || !simliFaceID) {
        console.error('Simli API key or Face ID is not defined');
      } else {
        console.log('Initializing Simli client...');
        const SimliConfig = {
          apiKey: simliApiKey,
          faceID: simliFaceID,
          handleSilence: true,
          videoRef: videoRef,
          audioRef: audioRef,
        };

        simliClientRef.current = new SimliClient();
        simliClientRef.current.Initialize(SimliConfig);
        
        console.log('Simli Client initialized');
      }
    }

    client.updateSession({ instructions: instructions });
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });

    client.on('error', (event: unknown) => console.error('Client error:', event));
    
    client.on('conversation.interrupted', async () => {
      console.log('Conversation interrupted, clearing audio buffer');
      simliAudioBufferRef.current = [];
    });
    
    client.on('conversation.updated', async ({ item, delta }: { item: ItemType; delta: { audio?: Int16Array } }) => {
      console.log('Conversation updated');
      const items = client.conversation.getItems();
    
      if (delta?.audio) {
        console.log('Processing audio delta');
        if (simliClientRef.current) {
          const audioData = new Int16Array(delta.audio);
          const resampledAudioData = resampleAudioData(audioData, 24000, 16000);
    
          if (isSimliDataChannelOpen()) {
            console.log('Data channel open, sending audio');
            if (simliAudioBufferRef.current.length > 0) {
              console.log('Sending buffered audio data');
              simliAudioBufferRef.current.forEach((bufferedData) => {
                if (simliClientRef.current) {
                  simliClientRef.current.sendAudioData(bufferedData);
                }
              });
              simliAudioBufferRef.current = [];
            }
            const resampledAudioDataUint8 = new Uint8Array(resampledAudioData.buffer);
            simliClientRef.current.sendAudioData(resampledAudioDataUint8);
          } else {
            console.log('Data channel not open, buffering audio');
            const resampledAudioDataUint8 = new Uint8Array(resampledAudioData.buffer);
            simliAudioBufferRef.current.push(resampledAudioDataUint8);
          }
        }
      }
    
      if (item.status === 'completed' && item.formatted.audio?.length) {
        console.log('Processing completed audio item');
        try {
          console.log('Decoding audio...');
          const wavFile = await WavRecorder.decode(
            item.formatted.audio,
            24000,
            24000
          );
          item.formatted.file = wavFile;
          console.log('Audio decoded successfully');

          // Ensure audio context is initialized
          if (!audioContext || audioContext.state === 'suspended') {
            console.log('Initializing/resuming AudioContext for playback');
            const ctx = audioContext || await initializeAudioContext();
            if (ctx && ctx.state === 'suspended') {
              await ctx.resume();
            }
          }

          // Create and play audio element
          console.log('Creating audio element for playback');
          const audio = new Audio(wavFile.url);
          audio.addEventListener('canplaythrough', () => {
            console.log('Audio ready to play');
            audio.play().catch(error => {
              console.error('Error playing audio:', error);
            });
          });
          
          audio.addEventListener('play', () => {
            console.log('Audio playback started');
          });
          
          audio.addEventListener('ended', () => {
            console.log('Audio playback completed');
          });
          
          audio.addEventListener('error', (e) => {
            console.error('Audio playback error:', e);
          });
        } catch (error) {
          console.error('Error processing audio:', error);
        }
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      console.log('Cleaning up component...');
      client.reset();
      if (simliClientRef.current) {
        simliClientRef.current.close();
      }
    };
  }, [isSimliDataChannelOpen, audioContext, initializeAudioContext]);

  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <img src="/openai-logomark.svg" alt="OpenAI Logo" />
          <span>realtime console</span>
        </div>
        <div className="content-api-key">
          {!USE_LOCAL_RELAY_SERVER_URL && (
            <Button
              icon={Edit}
              iconPosition="end"
              buttonStyle="flush"
              label={`api key: ${apiKey.slice(0, 3)}...`}
              onClick={resetAPIKey}
            />
          )}
        </div>
      </div>
      <div className="content-main">
        <div className="content-center">
          <div className="content-avatar">
            <img src={simliLogo} alt="Simli Logo" />
            <div className="content-block-title"></div>
            <div className="content-avatar-body">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{ width: '100%', height: 'auto' }}
              />
              <audio 
                ref={audioRef} 
                autoPlay
                onPlay={() => console.log('Audio element started playing')}
                onError={(e) => console.error('Audio element error:', e)}
              />
            </div>
          </div>

          <div className="content-block conversation">
            <div className="content-block-title"></div>
            <div className="content-block-body" data-conversation-content>
              <div className="center-text">
                {!items.length && "...let's get connected!"}
              </div>
              {items.map((conversationItem) => {
                const displayText = (conversationItem.role || conversationItem.type || '').replaceAll('_', ' ');
                return (
                  <div className="conversation-item" key={conversationItem.id}>
                    <div className={`speaker ${conversationItem.role || ''}`}>
                      <div>{displayText}</div>
                      <div
                        className="close"
                        onClick={() =>
                          deleteConversationItem(conversationItem.id)
                        }
                      >
                        <X />
                      </div>
                    </div>
                    <div className="speaker-content">
                      {conversationItem.type === 'function_call_output' && (
                        <div>{conversationItem.formatted.output}</div>
                      )}
                      {!!conversationItem.formatted.tool && (
                        <div>
                          {conversationItem.formatted.tool.name}(
                          {conversationItem.formatted.tool.arguments})
                        </div>
                      )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'user' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              (conversationItem.formatted.audio?.length
                                ? '(awaiting transcript)'
                                : conversationItem.formatted.text ||
                                  '(item sent)')}
                          </div>
                        )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'assistant' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              conversationItem.formatted.text ||
                              '(truncated)'}
                          </div>
                        )}
                      {conversationItem.formatted.file && (
                        <audio
                          src={conversationItem.formatted.file.url}
                          controls
                          onPlay={() => {
                            console.log('Audio controls: playback started');
                            if (!audioContext || audioContext.state === 'suspended') {
                              initializeAudioContext();
                            }
                          }}
                          onError={(e) => console.error('Audio controls error:', e)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="content-actions">
            <div className="button-container">
              <Button
                label={isRecording ? 'Release to Send' : 'Push to Talk'}
                buttonStyle={isRecording ? 'alert' : 'regular'}
                disabled={!isConnected}
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
              />
              <Button
                label={isConnected ? 'Disconnect' : 'Connect'}
                iconPosition={isConnected ? 'end' : 'start'}
                icon={isConnected ? X : Zap}
                buttonStyle={isConnected ? 'regular' : 'action'}
                onClick={
                  isConnected ? disconnectConversation : connectConversation
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
