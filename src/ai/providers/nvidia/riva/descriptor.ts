/**
 * Riva ASR protobuf descriptor — the *minimum* of NVIDIA's `riva_asr.proto`
 * this integration speaks.
 *
 * Why a JSON descriptor and not a `.proto` file: `protoLoader.loadSync` reads
 * from disk at runtime, which means shipping `.proto` files through the Next.js
 * build and resolving them against the process cwd. `protoLoader.fromJSON`
 * takes this object instead, so the schema is an ordinary module — bundled,
 * type-checked, and impossible to lose in a deploy.
 *
 * Field numbers are copied verbatim from NVIDIA's published protos
 * (https://github.com/nvidia-riva/common, `riva/proto/riva_asr.proto` and
 * `riva/proto/riva_audio.proto`).
 *
 * Both `StreamingRecognize` and the unary `Recognize` are declared:
 * NVIDIA's NVCF-hosted `parakeet-tdt-0.6b-v2` function only implements the
 * unary RPC today — `StreamingRecognize` against it fails immediately with
 * `INVALID_ARGUMENT` and no message, confirmed against the live endpoint —
 * so `Recognize` is what `riva/transport.ts` actually calls. `StreamingRecognize`
 * stays declared for a self-hosted Speech NIM or a future NVCF release that adds
 * streaming support.
 *
 * Fields we do not declare (`RequestId`, diarisation, endpointing, pipeline
 * states) are skipped by protobuf decoding rather than rejected, so omitting
 * them is safe.
 *
 * Regenerate with protobufjs:
 *   new protobuf.Root().loadSync('riva/proto/riva_asr.proto', { keepCase: true }).toJSON()
 */

/** protobufjs JSON descriptor, consumed by `protoLoader.fromJSON`. */
export const RIVA_ASR_DESCRIPTOR =
  {
  "nested": {
    "nvidia": {
      "nested": {
        "riva": {
          "nested": {
            "asr": {
              "nested": {
                "RivaSpeechRecognition": {
                  "methods": {
                    "StreamingRecognize": {
                      "requestType": "StreamingRecognizeRequest",
                      "requestStream": true,
                      "responseType": "StreamingRecognizeResponse",
                      "responseStream": true
                    },
                    "Recognize": {
                      "requestType": "RecognizeRequest",
                      "responseType": "RecognizeResponse"
                    }
                  }
                },
                "RecognizeRequest": {
                  "fields": {
                    "config": {
                      "type": "RecognitionConfig",
                      "id": 1
                    },
                    "audio": {
                      "type": "bytes",
                      "id": 2
                    }
                  }
                },
                "RecognizeResponse": {
                  "fields": {
                    "results": {
                      "rule": "repeated",
                      "type": "SpeechRecognitionResult",
                      "id": 1
                    }
                  }
                },
                "SpeechRecognitionResult": {
                  "fields": {
                    "alternatives": {
                      "rule": "repeated",
                      "type": "SpeechRecognitionAlternative",
                      "id": 1
                    },
                    "channel_tag": {
                      "type": "int32",
                      "id": 2
                    },
                    "audio_processed": {
                      "type": "float",
                      "id": 3
                    }
                  }
                },
                "StreamingRecognizeRequest": {
                  "oneofs": {
                    "streaming_request": {
                      "oneof": [
                        "streaming_config",
                        "audio_content"
                      ]
                    }
                  },
                  "fields": {
                    "streaming_config": {
                      "type": "StreamingRecognitionConfig",
                      "id": 1
                    },
                    "audio_content": {
                      "type": "bytes",
                      "id": 2
                    }
                  }
                },
                "StreamingRecognitionConfig": {
                  "fields": {
                    "config": {
                      "type": "RecognitionConfig",
                      "id": 1
                    },
                    "interim_results": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "RecognitionConfig": {
                  "fields": {
                    "encoding": {
                      "type": "nvidia.riva.AudioEncoding",
                      "id": 1
                    },
                    "sample_rate_hertz": {
                      "type": "int32",
                      "id": 2
                    },
                    "language_code": {
                      "type": "string",
                      "id": 3
                    },
                    "max_alternatives": {
                      "type": "int32",
                      "id": 4
                    },
                    "audio_channel_count": {
                      "type": "int32",
                      "id": 7
                    },
                    "enable_word_time_offsets": {
                      "type": "bool",
                      "id": 8
                    },
                    "enable_automatic_punctuation": {
                      "type": "bool",
                      "id": 11
                    },
                    "model": {
                      "type": "string",
                      "id": 13
                    },
                    "verbatim_transcripts": {
                      "type": "bool",
                      "id": 14
                    }
                  }
                },
                "StreamingRecognizeResponse": {
                  "fields": {
                    "results": {
                      "rule": "repeated",
                      "type": "StreamingRecognitionResult",
                      "id": 1
                    }
                  }
                },
                "StreamingRecognitionResult": {
                  "fields": {
                    "alternatives": {
                      "rule": "repeated",
                      "type": "SpeechRecognitionAlternative",
                      "id": 1
                    },
                    "is_final": {
                      "type": "bool",
                      "id": 2
                    },
                    "stability": {
                      "type": "float",
                      "id": 3
                    },
                    "channel_tag": {
                      "type": "int32",
                      "id": 5
                    },
                    "audio_processed": {
                      "type": "float",
                      "id": 6
                    }
                  }
                },
                "SpeechRecognitionAlternative": {
                  "fields": {
                    "transcript": {
                      "type": "string",
                      "id": 1
                    },
                    "confidence": {
                      "type": "float",
                      "id": 2
                    },
                    "words": {
                      "rule": "repeated",
                      "type": "WordInfo",
                      "id": 3
                    },
                    "language_code": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "WordInfo": {
                  "fields": {
                    "start_time": {
                      "type": "int32",
                      "id": 1
                    },
                    "end_time": {
                      "type": "int32",
                      "id": 2
                    },
                    "word": {
                      "type": "string",
                      "id": 3
                    },
                    "confidence": {
                      "type": "float",
                      "id": 4
                    },
                    "speaker_tag": {
                      "type": "int32",
                      "id": 5
                    },
                    "language_code": {
                      "type": "string",
                      "id": 6
                    }
                  }
                }
              }
            },
            "AudioEncoding": {
              "values": {
                "ENCODING_UNSPECIFIED": 0,
                "LINEAR_PCM": 1,
                "FLAC": 2,
                "MULAW": 3,
                "OGGOPUS": 4,
                "ALAW": 20
              }
            }
          }
        }
      }
    }
  }
} as const;
