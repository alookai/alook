/* SPDX-License-Identifier: Apache-2.0
Modified from Waveshare 06_ES7210; see third_party/NOTICE.md. */
#include "audio.h"
#include "configuration.h"
#include "src/codec/es7210.h"
#include <Arduino.h>
#include <Wire.h>
#include <driver/i2s.h>
#include <esp_heap_caps.h>
#include <pin_config.h>
#include <cstring>

namespace alook_touch {
namespace {
constexpr size_t capacity = 44 + audio_max_samples * 2;
void le16(uint8_t* out, uint16_t value) { out[0] = value; out[1] = value >> 8; }
void le32(uint8_t* out, uint32_t value) { for (unsigned i = 0; i < 4; ++i) out[i] = value >> (8 * i); }
}
AudioClip::~AudioClip() { if (data) { memset(data, 0, size); heap_caps_free(data); } }
bool AudioRecorder::begin() {
  if (ready_) return true;
  audio_hal_codec_config_t codec{};
  codec.adc_input = AUDIO_HAL_ADC_INPUT_ALL;
  codec.codec_mode = AUDIO_HAL_CODEC_MODE_ENCODE;
  codec.i2s_iface.mode = AUDIO_HAL_MODE_SLAVE;
  codec.i2s_iface.fmt = AUDIO_HAL_I2S_NORMAL;
  codec.i2s_iface.samples = AUDIO_HAL_16K_SAMPLES;
  codec.i2s_iface.bits = AUDIO_HAL_BIT_LENGTH_16BITS;
  if (es7210_adc_init(&Wire, &codec) != ESP_OK
    || es7210_adc_config_i2s(codec.codec_mode, &codec.i2s_iface) != ESP_OK
    || es7210_adc_set_gain(static_cast<es7210_input_mics_t>(ES7210_INPUT_MIC1 | ES7210_INPUT_MIC2), GAIN_0DB) != ESP_OK
    || es7210_adc_set_gain(static_cast<es7210_input_mics_t>(ES7210_INPUT_MIC3 | ES7210_INPUT_MIC4), GAIN_37_5DB) != ESP_OK
    || es7210_adc_ctrl_state(codec.codec_mode, AUDIO_HAL_CTRL_START) != ESP_OK) return false;
  i2s_config_t config{};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
  config.sample_rate = audio_sample_rate;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 8;
  config.dma_buf_len = 128;
  config.mclk_multiple = I2S_MCLK_MULTIPLE_256;
  config.bits_per_chan = I2S_BITS_PER_CHAN_16BIT;
  config.chan_mask = I2S_TDM_ACTIVE_CH0;
  if (i2s_driver_install(I2S_NUM_1, &config, 0, nullptr) != ESP_OK) return false;
  i2s_pin_config_t pins{};
  pins.bck_io_num = PIN_ES7210_BCLK; pins.ws_io_num = PIN_ES7210_LRCK;
  pins.data_in_num = PIN_ES7210_DIN; pins.data_out_num = I2S_PIN_NO_CHANGE; pins.mck_io_num = PIN_ES7210_MCLK;
  if (i2s_set_pin(I2S_NUM_1, &pins) != ESP_OK) { i2s_driver_uninstall(I2S_NUM_1); return false; }
  i2s_stop(I2S_NUM_1);
  ready_ = true;
  return true;
}
bool AudioRecorder::start() {
  cancel();
  if (!begin()) return false;
  auto clip = std::make_shared<AudioClip>();
  clip->data = static_cast<uint8_t*>(heap_caps_malloc(capacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!clip->data) return false;
  clip->size = 44;
  clip_ = std::move(clip);
  i2s_zero_dma_buffer(I2S_NUM_1);
  if (i2s_start(I2S_NUM_1) != ESP_OK) { clip_.reset(); return false; }
  return true;
}
void AudioRecorder::tick() {
  if (!clip_ || full()) return;
  size_t count = 0;
  const size_t room = std::min(static_cast<size_t>(4096), capacity - clip_->size);
  if (i2s_read(I2S_NUM_1, clip_->data + clip_->size, room, &count, 0) == ESP_OK) clip_->size += count - count % 2;
}
bool AudioRecorder::full() const { return clip_ && clip_->size >= capacity; }
std::shared_ptr<AudioClip> AudioRecorder::finish() {
  if (!clip_) return nullptr;
  tick();
  i2s_stop(I2S_NUM_1);
  auto clip = std::move(clip_);
  if (clip->size <= 44 + audio_sample_rate / 5) return nullptr;
  auto* out = clip->data;
  memcpy(out, "RIFF", 4); le32(out + 4, clip->size - 8); memcpy(out + 8, "WAVEfmt ", 8);
  le32(out + 16, 16); le16(out + 20, 1); le16(out + 22, 1); le32(out + 24, audio_sample_rate);
  le32(out + 28, audio_sample_rate * 2); le16(out + 32, 2); le16(out + 34, 16);
  memcpy(out + 36, "data", 4); le32(out + 40, clip->size - 44);
  return clip;
}
void AudioRecorder::cancel() { if (clip_ && ready_) i2s_stop(I2S_NUM_1); clip_.reset(); }
}
