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

  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  const isSimliDataChannelOpen = useCallback(() => {
    if (!simliClientRef.current) return false;
  
    const pc = (simliClientRef.current as any).pc as RTCPeerConnection | null;
    const dc = (simliClientRef.current as any).dc as RTCDataChannel | null;
  
    return pc !== null && pc.iceConnectionState === 'connected' && dc !== null && dc.readyState === 'open';
  }, []);
  
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;

    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());
  
    if (simliClientRef.current) {
      simliClientRef.current.start();
      const audioData = new Uint8Array(6000).fill(0);
      simliClientRef.current.sendAudioData(audioData);
      console.log('Sent initial empty audio data to Simli');
    }
  
    await client.connect();
    await wavRecorder.begin();
    await wavStreamPlayerRef.current.connect();
    
    if (client.getTurnDetectionType() === 'server_vad') {
      await wavRecorder.record((data: { mono: any }) => client.appendInputAudio(data.mono));
    }
  }, []);
  
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
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();

    if (simliClientRef.current) {
      simliClientRef.current.close();
    }
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  const startRecording = async () => {
    setIsRecording(true);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      await client.cancelResponse(trackId, offset);
    }
    await wavRecorder.record((data: { mono: any }) => client.appendInputAudio(data.mono));
  };

  const stopRecording = async () => {
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    client.createResponse();
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
    const client = clientRef.current;

    if (videoRef.current && audioRef.current) {
      const simliApiKey = process.env.REACT_APP_SIMLI_API_KEY;
      const simliFaceID = process.env.REACT_APP_SIMLI_FACE_ID;

      if (!simliApiKey || !simliFaceID) {
        console.error('Simli API key or Face ID is not defined');
      } else {
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

    client.on('error', (event: unknown) => console.error(event));
    
    client.on('conversation.interrupted', async () => {
      simliAudioBufferRef.current = [];
    });
    
    client.on('conversation.updated', async ({ item, delta }: { item: ItemType; delta: { audio?: Int16Array } }) => {
      const items = client.conversation.getItems();
    
      if (delta?.audio) {
        if (simliClientRef.current) {
          const audioData = new Int16Array(delta.audio);
          const resampledAudioData = resampleAudioData(audioData, 24000, 16000);
    
          if (isSimliDataChannelOpen()) {
            if (simliAudioBufferRef.current.length > 0) {
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
            const resampledAudioDataUint8 = new Uint8Array(resampledAudioData.buffer);
            simliAudioBufferRef.current.push(resampledAudioDataUint8);
            console.warn('Data channel is not open yet, buffering audio data');
          }
        }
      }
    
      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      client.reset();
      if (simliClientRef.current) {
        simliClientRef.current.close();
      }
    };
  }, [isSimliDataChannelOpen]);

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
            <img src="simli_small_logo.jpg" alt="Simli Logo" />
            <div className="content-block-title"></div>
            <div className="content-avatar-body">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{ width: '100%', height: 'auto' }}
              />
              <audio ref={audioRef} autoPlay/>
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
