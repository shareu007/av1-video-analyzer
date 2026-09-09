#ifndef AV1_INSPECTION_H_
#define AV1_INSPECTION_H_

#include <stdint.h>

typedef struct insp_mv {
  int16_t row;
  int16_t col;
} insp_mv;

typedef struct insp_mi_data {
  insp_mv mv[2];
  int16_t ref_frame[2];
  int16_t mode;
  int16_t uv_mode;
  int16_t bsize;
  int16_t skip;
  int16_t segment_id;
  int16_t dual_filter_type;
  int16_t filter[2];
  int16_t tx_type;
  int16_t tx_size;
  int16_t cdef_level;
  int16_t cdef_strength;
  int16_t cfl_alpha_idx;
  int16_t cfl_alpha_sign;
  int16_t current_qindex;
  int16_t compound_type;
  int16_t motion_mode;
  int16_t intrabc;
  int16_t palette;
  int16_t uv_palette;
  int16_t partition;
  int32_t coeff_non_zero;
} insp_mi_data;

typedef struct insp_frame_data {
  insp_mi_data *mi_grid;
  int16_t frame_number;
  int show_frame;
  int frame_type;
  int base_qindex;
  int frame_width;
  int frame_height;
  int mi_rows;
  int mi_cols;
  int tile_mi_rows;
  int tile_mi_cols;
  int16_t y_dequant[8][2];
  int16_t u_dequant[8][2];
  int16_t v_dequant[8][2];
  int delta_q_present_flag;
  int delta_q_res;
  int show_existing_frame;
} insp_frame_data;

void ifd_init(insp_frame_data *frame, int frame_width, int frame_height);
void ifd_clear(insp_frame_data *frame);
int ifd_inspect(insp_frame_data *frame, void *decoder, int skip_not_transform);

#endif
