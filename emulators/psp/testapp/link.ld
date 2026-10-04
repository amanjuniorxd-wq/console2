ENTRY(_start)
PHDRS { all PT_LOAD FLAGS(7); }
SECTIONS {
  . = 0x08804000;
  .text : { *(.text .text.*) } :all
  .sceStub.text : { *(.sceStub.text) }
  .rodata.sceModuleInfo : { KEEP(*(.rodata.sceModuleInfo)) }
  .rodata.sceResident : { *(.rodata.sceResident) }
  .rodata.sceNid : { *(.rodata.sceNid) }
  .lib.ent.top : { KEEP(*(.lib.ent.top)) }
  .lib.ent : { KEEP(*(.lib.ent)) }
  .lib.ent.btm : { KEEP(*(.lib.ent.btm)) }
  .lib.stub : { KEEP(*(.lib.stub)) }
  .rodata : { *(.rodata .rodata.*) }
  .data : { *(.data .data.*) }
  _gp = ALIGN(16) + 0x7ff0;
  .sdata : { *(.sdata .sdata.*) }
  .sbss : { *(.sbss .sbss.*) }
  .bss : { *(.bss .bss.* COMMON) }
  /DISCARD/ : { *(.comment) *(.note*) *(.MIPS.abiflags) *(.reginfo) *(.pdr) *(.eh_frame*) *(.gnu.attributes) }
}
