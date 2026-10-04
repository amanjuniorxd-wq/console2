/* PS3 (LV2) executable layout: RX segment at 0x10000, RW segment after it, plus the two LV2 parameter segments. */
OUTPUT_FORMAT("elf64-powerpc")
ENTRY(_start_opd)
PHDRS {
  text PT_LOAD FLAGS(0x00400005);
  data PT_LOAD FLAGS(0x00600006);
  proc_param 0x60000001;
  prx_param 0x60000002;
}
SECTIONS {
  . = 0x10000;
  .text : { *(.text .text.*) } :text
  .rodata : { *(.rodata .rodata.*) } :text
  .sys_proc_param : { KEEP(*(.sys_proc_param)) } :text :proc_param
  .sys_proc_prx_param : { KEEP(*(.sys_proc_prx_param)) } :text :prx_param
  .lib.stub : { KEEP(*(.lib.stub)) } :text
  . = ALIGN(0x10000);
  .data : { *(.data.opd) *(.data .data.*) } :data
  .got : { *(.got .toc) } :data
  .bss : { *(.bss .bss.* COMMON) } :data
  /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) }
}
