# MISHRIN PS2-class TEST ROM — an original, tiny replacement for the console boot ROM, written from scratch for
# automated emulator tests. It contains no code or data from any console vendor. It is NOT a BIOS: it cannot boot
# games. PCSX2 executes it on both CPUs from the reset vector (0xBFC00000):
#   EE (R5900):  drives the GS directly (privileged registers + GIF DMA) and draws, every vsync:
#                a saffron box moved by the D-pad, 16 button indicators, two analog-stick markers, a score bar
#                (cross) and a frame-counter square.
#   IOP (R3000): loads the saved state from the memory card, reads the inserted disc (ISO9660 → GAME.DAT, through
#                the CDVD read command + DMA 3), talks to controller port 1 through SIO2 (analog mode, polling) and
#                publishes everything in IOP RAM, which the EE reads at 0xBC001000.
#   Sound: a looping square tone on SPU2 core 1 voice 0.
#   Without a Mishrin test disc the box is grey; with one, it takes the disc's colour (proof the image was loaded).
# Layout matches what PCSX2 checks in a boot ROM: a ROMDIR table with RESET / ROMDIR / EXTINFO / ROMVER entries.
	.set	noat
	.set	reorder
	.text
	.globl	_start
_start:
	mfc0	$k0, $15			# PRId: EE 0x2e20, IOP 0x001f
	andi	$k0, $k0, 0xff00
	bnez	$k0, ee_main
	j	iop_main
# ------------------------------------------------------------------------------------------------ vectors
	.org	0x200
	j	.				# TLB refill (BEV)
	.org	0x380
	j	.				# general exception (BEV)
	.org	0x400

# ------------------------------------------------------------------------------------------------ EE
	.set	mips3
.macro SET64 base, off, hi, lo
	li	$t2, \hi
	dsll32	$t2, $t2, 0
	li	$t3, \lo
	dsll32	$t3, $t3, 0
	dsrl32	$t3, $t3, 0
	or	$t2, $t2, $t3
	sd	$t2, \off(\base)
.endm
# AD reg, lo(reg) hi(reg): append an A+D qword at $s7
.macro AD addr, lo, hi
	sw	\lo, 0($s7)
	sw	\hi, 4($s7)
	li	$at, \addr
	sw	$at, 8($s7)
	sw	$zero, 12($s7)
	addiu	$s7, $s7, 16
.endm
.macro ADI addr, lo, hi
	li	$a2, \lo
	li	$a3, \hi
	AD	\addr, $a2, $a3
.endm
# XY reg with x in \rx, y in \ry (pixels) → XYZ2 (12.4 fixed point)
.macro XY rx, ry
	sll	$a2, \rx, 4
	sll	$a3, \ry, 4
	sll	$a3, $a3, 16
	or	$a2, $a2, $a3
	AD	0x05, $a2, $zero
.endm

ee_main:
	lui	$t0, 0x0040			# Status: BEV=1, ERL=0, EXL=0, interrupts off, kernel mode
	mtc0	$t0, $12
	li	$t1, 0xB000E000			# DMAC: enable
	li	$t0, 1
	sw	$t0, 0($t1)
	li	$t1, 0xB0003000			# GIF: reset
	sw	$t0, 0($t1)
	li	$s6, 0xB2000000			# GS privileged registers
	li	$t0, 0x200			# CSR.RESET
	sw	$t0, 0x1000($s6)
	SET64	$s6, 0x00, 0x00000000, 0x0000FF25	# PMODE: circuit 1 on, fixed alpha 0xFF
	SET64	$s6, 0x20, 0x00000000, 0x00000001	# SMODE2: interlaced, frame mode
	SET64	$s6, 0x70, 0x00000000, 0x00001400	# DISPFB1: FBP 0, FBW 640, PSMCT32
	SET64	$s6, 0x80, 0x001BF9FF, 0x01824290	# DISPLAY1: 640x448, MAGH 4
	SET64	$s6, 0xE0, 0x00000000, 0x00000000	# BGCOLOR black
	li	$s0, 288			# box x
	li	$s1, 192			# box y
	li	$s2, 0				# score
	li	$s3, 0				# frame counter
	li	$s5, 0				# previous buttons
	li	$t1, 0xBC001000			# wait (≤ ~5 s) for the IOP's memory-card load
	li	$t2, 300
wl:	lw	$t0, 0x30($t1)
	bnez	$t0, wld
	li	$t0, 8
	sw	$t0, 0x1000($s6)
1:	lw	$t0, 0x1000($s6)
	andi	$t0, $t0, 8
	beqz	$t0, 1b
	addiu	$t2, $t2, -1
	bnez	$t2, wl
wld:	lw	$t0, 0x30($t1)
	li	$t3, 1
	bne	$t0, $t3, frame
	lw	$s0, 0x20($t1)			# restore x, y, score
	lw	$s1, 0x24($t1)
	lw	$s2, 0x28($t1)
frame:
	li	$t0, 8				# wait for vsync: clear CSR.VSINT, poll until it is set again
	sw	$t0, 0x1000($s6)
vs:	lw	$t0, 0x1000($s6)
	andi	$t0, $t0, 8
	beqz	$t0, vs
	addiu	$s3, $s3, 1
	li	$t1, 0xBC001000			# controller state published by the IOP
	lw	$s4, 0($t1)			# bits 0..15 pressed buttons (SIO2 order), 16..23 mode, 24..31 sequence
	lw	$t9, 4($t1)			# RX RY LX LY
	andi	$t0, $s4, 0x10			# UP (bit 4)
	beqz	$t0, 1f
	addiu	$s1, $s1, -4
1:	andi	$t0, $s4, 0x40			# DOWN
	beqz	$t0, 1f
	addiu	$s1, $s1, 4
1:	andi	$t0, $s4, 0x80			# LEFT
	beqz	$t0, 1f
	addiu	$s0, $s0, -4
1:	andi	$t0, $s4, 0x20			# RIGHT
	beqz	$t0, 1f
	addiu	$s0, $s0, 4
1:	slti	$t0, $s0, 0			# clamp to the 640x448 frame
	beqz	$t0, 1f
	li	$s0, 0
1:	slti	$t0, $s0, 577
	bnez	$t0, 1f
	li	$s0, 576
1:	slti	$t0, $s1, 32
	beqz	$t0, 1f
	li	$s1, 32
1:	slti	$t0, $s1, 321
	bnez	$t0, 1f
	li	$s1, 320
1:	andi	$t0, $s4, 0x4000		# CROSS pressed this frame (edge) → score + 1
	andi	$t1, $s5, 0x4000
	beqz	$t0, 1f
	bnez	$t1, 1f
	addiu	$s2, $s2, 1
1:	andi	$t0, $s4, 0x08			# START pressed this frame (edge) → save to the memory card
	andi	$t1, $s5, 0x08
	beqz	$t0, 1f
	bnez	$t1, 1f
	li	$t1, 0xBC001000
	sw	$s0, 0x14($t1)
	sw	$s1, 0x18($t1)
	sw	$s2, 0x1C($t1)
	li	$t0, 0x53415645			# 'SAVE'
	sw	$t0, 0x10($t1)
1:	move	$s5, $s4

	# ---- GIF packet (PATH3, A+D) at physical 0x00100000
	li	$s7, 0xA0100010
	ADI	0x4C, 0x000A0000, 0		# FRAME_1: FBP 0, FBW 10 (640), PSMCT32
	ADI	0x4E, 0x00000000, 1		# ZBUF_1: Z writes masked
	ADI	0x40, 0x027F0000, 0x01BF0000	# SCISSOR_1: 0..639 x 0..447
	ADI	0x18, 0, 0			# XYOFFSET_1
	ADI	0x1A, 1, 0			# PRMODECONT
	ADI	0x47, 0x00030000, 0		# TEST_1: ZTE on, always pass
	ADI	0x00, 6, 0			# PRIM: sprite
	ADI	0x01, 0x80100810, 0x3F800000	# RGBAQ: background
	li	$t4, 0
	li	$t5, 0
	XY	$t4, $t5
	li	$t4, 640
	li	$t5, 448
	XY	$t4, $t5
	li	$t1, 0xBC001000			# box colour comes from the disc (GAME.DAT); grey without a game
	lw	$t0, 0x40($t1)
	li	$a2, 0x80808080
	li	$t3, 1
	bne	$t0, $t3, 1f
	lw	$a2, 0x44($t1)
1:	li	$a3, 0x3F800000
	AD	0x01, $a2, $a3			# box
	XY	$s0, $s1
	addiu	$t4, $s0, 64
	addiu	$t5, $s1, 64
	XY	$t4, $t5
	# 16 button indicators along the bottom, in the console's full-pad order
	la	$t6, order
	li	$t7, 0				# i
ind:	addu	$t0, $t6, $t7
	lbu	$t0, 0($t0)
	srlv	$t0, $s4, $t0
	andi	$t0, $t0, 1
	li	$a2, 0x80303030			# dark grey (released)
	beqz	$t0, 1f
	li	$a2, 0x8000FF00			# green (pressed)
1:	li	$a3, 0x3F800000
	AD	0x01, $a2, $a3
	sll	$t4, $t7, 5			# x = 40*i + 4 (16 indicators fit in 640 px)
	sll	$t5, $t7, 3
	addu	$t4, $t4, $t5
	addiu	$t4, $t4, 4
	li	$t5, 400
	XY	$t4, $t5
	addiu	$t4, $t4, 32
	li	$t5, 432
	XY	$t4, $t5
	addiu	$t7, $t7, 1
	slti	$t0, $t7, 16
	bnez	$t0, ind
	# analog sticks: 32x32 markers around (120,350) and (520,350), offset (value-128)/4
	srl	$t0, $t9, 16			# LX
	andi	$t0, $t0, 0xFF
	srl	$t1, $t9, 24			# LY
	ADI	0x01, 0x80FFFFFF, 0x3F800000
	srl	$t4, $t0, 2
	addiu	$t4, $t4, 72
	srl	$t5, $t1, 2
	addiu	$t5, $t5, 302
	XY	$t4, $t5
	addiu	$t4, $t4, 16
	addiu	$t5, $t5, 16
	XY	$t4, $t5
	andi	$t0, $t9, 0xFF			# RX
	srl	$t1, $t9, 8
	andi	$t1, $t1, 0xFF			# RY
	ADI	0x01, 0x80FF60C0, 0x3F800000
	srl	$t4, $t0, 2
	addiu	$t4, $t4, 472
	srl	$t5, $t1, 2
	addiu	$t5, $t5, 302
	XY	$t4, $t5
	addiu	$t4, $t4, 16
	addiu	$t5, $t5, 16
	XY	$t4, $t5
	# score bar (8 px per point) and a frame-counter square that moves every frame
	ADI	0x01, 0x8037AFD4, 0x3F800000
	li	$t4, 8
	li	$t5, 8
	XY	$t4, $t5
	sll	$t4, $s2, 3
	addiu	$t4, $t4, 9
	li	$t5, 20
	XY	$t4, $t5
	ADI	0x01, 0x80FFFFFF, 0x3F800000
	andi	$t4, $s3, 0x1FF
	addiu	$t4, $t4, 64
	li	$t5, 0
	XY	$t4, $t5
	addiu	$t4, $t4, 8
	li	$t5, 8
	XY	$t4, $t5
	# status squares, top right: memory-card load (green loaded / blue no save / red pending),
	# save (green done / red in progress / grey none)
	li	$t1, 0xBC001000
	lw	$t0, 0x30($t1)
	li	$a2, 0x800000FF
	li	$t3, 1
	bne	$t0, $t3, 1f
	li	$a2, 0x8000FF00
1:	li	$t3, 2
	bne	$t0, $t3, 1f
	li	$a2, 0x80FF0000
1:	li	$a3, 0x3F800000
	AD	0x01, $a2, $a3
	li	$t4, 584
	li	$t5, 8
	XY	$t4, $t5
	li	$t4, 600
	li	$t5, 24
	XY	$t4, $t5
	li	$t1, 0xBC001000			# disc: green game loaded / blue no disc / red unreadable / grey pending
	lw	$t0, 0x40($t1)
	li	$a2, 0x80303030
	li	$t3, 1
	bne	$t0, $t3, 1f
	li	$a2, 0x8000FF00
1:	li	$t3, 2
	bne	$t0, $t3, 1f
	li	$a2, 0x80FF0000
1:	li	$t3, 3
	bne	$t0, $t3, 1f
	li	$a2, 0x800000FF
1:	li	$a3, 0x3F800000
	AD	0x01, $a2, $a3
	li	$t4, 560
	li	$t5, 8
	XY	$t4, $t5
	li	$t4, 576
	li	$t5, 24
	XY	$t4, $t5
	li	$t1, 0xBC001000
	lw	$t0, 0x10($t1)
	li	$a2, 0x80303030
	li	$t3, 0x53415645
	bne	$t0, $t3, 1f
	li	$a2, 0x800000FF
1:	li	$t3, 0x444F4E45
	bne	$t0, $t3, 1f
	li	$a2, 0x8000FF00
1:	li	$a3, 0x3F800000
	AD	0x01, $a2, $a3
	li	$t4, 608
	li	$t5, 8
	XY	$t4, $t5
	li	$t4, 624
	li	$t5, 24
	XY	$t4, $t5
	li	$t6, 0xBC001180			# diagnostics: last memory-card answer, one grey square per byte
	li	$t7, 0
dg:	addu	$t0, $t6, $t7
	lbu	$t0, 0($t0)
	sll	$t1, $t0, 8
	or	$t1, $t1, $t0
	sll	$t1, $t1, 8
	or	$t1, $t1, $t0
	lui	$t2, 0x8000
	or	$a2, $t1, $t2
	li	$a3, 0x3F800000
	AD	0x01, $a2, $a3
	sll	$t4, $t7, 3
	addiu	$t4, $t4, 64
	li	$t5, 376
	XY	$t4, $t5
	addiu	$t4, $t4, 8
	li	$t5, 384
	XY	$t4, $t5
	addiu	$t7, $t7, 1
	slti	$t0, $t7, 32
	bnez	$t0, dg
	# GIFtag: NLOOP = qwords - 1, EOP, PACKED, NREG 1, REGS A+D
	li	$t0, 0xA0100010
	subu	$t0, $s7, $t0
	srl	$t0, $t0, 4
	ori	$t0, $t0, 0x8000
	li	$t1, 0xA0100000
	sw	$t0, 0($t1)
	li	$t0, 0x10000000
	sw	$t0, 4($t1)
	li	$t0, 0xE
	sw	$t0, 8($t1)
	sw	$zero, 12($t1)
	# DMA channel 2 (GIF), normal mode, from memory
	li	$t0, 0xA0100000
	subu	$t0, $s7, $t0
	srl	$t0, $t0, 4
	li	$t1, 0xB000A000
	li	$t2, 0x00100000
	sw	$t2, 0x10($t1)			# MADR
	sw	$t0, 0x20($t1)			# QWC
	li	$t2, 0x101
	sw	$t2, 0($t1)			# CHCR: DIR from memory, STR
dw:	lw	$t2, 0($t1)
	andi	$t2, $t2, 0x100
	bnez	$t2, dw
	j	frame

# SIO2 button bit for each console full-pad button (up down left right cross circle square triangle l1 r1 l2 r2 select start l3 r3)
order:	.byte 4, 6, 7, 5, 14, 13, 15, 12, 10, 11, 8, 9, 0, 3, 1, 2

# ------------------------------------------------------------------------------------------------ IOP (MIPS I)
	.set	mips1
	.align	4
iop_main:
	li	$s0, 0xBF808200			# SIO2
	li	$s1, 0xA0001000			# published state (IOP RAM 0x1000)
	li	$s2, 0xA0001100			# response buffer
	sw	$zero, 0($s1)
	li	$t0, 0x80808080
	sw	$t0, 4($s1)
	# ---- memory card (port 1): load the saved state, if any, before the pad starts
	sw	$zero, 0x30($s1)		# load status: 0 pending, 1 loaded, 2 no save
	li	$s4, 200			# retries (the card may report "not inserted" for a moment)
mcl:	la	$a0, mc_read
	li	$a1, 31
	jal	xfer
	move	$t4, $s2			# scan the response for the magic
	li	$t3, 28
	li	$t6, 0x3248534D			# 'MSH2'
2:	lbu	$t0, 0($t4)
	nop
	lbu	$t1, 1($t4)
	nop
	sll	$t1, $t1, 8
	or	$t0, $t0, $t1
	lbu	$t1, 2($t4)
	nop
	sll	$t1, $t1, 16
	or	$t0, $t0, $t1
	lbu	$t1, 3($t4)
	nop
	sll	$t1, $t1, 24
	or	$t0, $t0, $t1
	beq	$t0, $t6, mcfound
	addiu	$t4, $t4, 1
	addiu	$t3, $t3, -1
	bnez	$t3, 2b
	lbu	$t0, 13($s2)			# 0x2B somewhere in the header = the card answered (no save)
	nop
	li	$t1, 0x2B
	beq	$t0, $t1, mcnone
	lbu	$t0, 12($s2)
	nop
	beq	$t0, $t1, mcnone
	addiu	$s4, $s4, -1
	beqz	$s4, mcnone
	li	$t0, 50000
1:	addiu	$t0, $t0, -1
	bnez	$t0, 1b
	j	mcl
mcfound:
	li	$t5, 3				# copy x, y, score (unaligned bytes → words)
	addiu	$t4, $t4, 4			# payload follows the magic
	li	$t7, 0xA0001020
3:	lbu	$t0, 0($t4)
	nop
	lbu	$t1, 1($t4)
	nop
	sll	$t1, $t1, 8
	or	$t0, $t0, $t1
	lbu	$t1, 2($t4)
	nop
	sll	$t1, $t1, 16
	or	$t0, $t0, $t1
	lbu	$t1, 3($t4)
	nop
	sll	$t1, $t1, 24
	or	$t0, $t0, $t1
	sw	$t0, 0($t7)
	addiu	$t4, $t4, 4
	addiu	$t7, $t7, 4
	addiu	$t5, $t5, -1
	bnez	$t5, 3b
	li	$t0, 1
	sw	$t0, 0x30($s1)
	j	mcdone
mcnone:	li	$t0, 2
	sw	$t0, 0x30($s1)
mcdone:
	# ---- disc (CDVD): find GAME.DAT through ISO9660 and load the game's data (box colour + title)
	sw	$zero, 0x40($s1)		# disc status: 0 pending, 1 game loaded, 2 no disc, 3 unreadable / not a test disc
	li	$s5, 400			# wait for the drive to report a disc type
dt:	li	$t1, 0xBF40200F
	lbu	$t0, 0($t1)			# TYPE: 0x00 no disc, 0x01-0x05 detecting, 0x10+ a disc
	nop
	sb	$t0, 0x4C($s1)
	slti	$t1, $t0, 0x10
	beqz	$t1, dhave
	addiu	$s5, $s5, -1
	beqz	$s5, dnone
	li	$t0, 20000
1:	addiu	$t0, $t0, -1
	bnez	$t0, 1b
	j	dt
dhave:	li	$a0, 16				# primary volume descriptor
	jal	readsec
	beqz	$v0, dbad
	li	$t1, 0xA0002000
	lbu	$t0, 1($t1)			# 'CD001'
	nop
	li	$t2, 0x43
	bne	$t0, $t2, dbad
	lbu	$t0, 158($t1)			# root directory extent (LE u32 at 156+2)
	nop
	lbu	$t2, 159($t1)
	nop
	sll	$t2, $t2, 8
	or	$t0, $t0, $t2
	lbu	$t2, 160($t1)
	nop
	sll	$t2, $t2, 16
	or	$a0, $t0, $t2
	jal	readsec
	beqz	$v0, dbad
	li	$t1, 0xA0002000			# walk the directory records looking for GAME.DAT;1
	li	$t9, 0xA0002800
dr:	lbu	$t2, 0($t1)			# record length
	nop
	beqz	$t2, dbad
	lbu	$t0, 32($t1)			# name length
	nop
	li	$t3, 10
	bne	$t0, $t3, dnext
	la	$t4, gamedat
	addiu	$t5, $t1, 33
	li	$t3, 10
2:	lbu	$t6, 0($t4)
	nop
	lbu	$t7, 0($t5)
	nop
	bne	$t6, $t7, dnext
	addiu	$t4, $t4, 1
	addiu	$t5, $t5, 1
	addiu	$t3, $t3, -1
	bnez	$t3, 2b
	lbu	$t0, 2($t1)			# extent LBA
	nop
	lbu	$t3, 3($t1)
	nop
	sll	$t3, $t3, 8
	or	$t0, $t0, $t3
	lbu	$t3, 4($t1)
	nop
	sll	$t3, $t3, 16
	or	$a0, $t0, $t3
	jal	readsec
	beqz	$v0, dbad
	li	$t1, 0xA0002000
	lw	$t0, 0($t1)			# 'MSHR' 'GAME'
	nop
	li	$t2, 0x5248534D
	bne	$t0, $t2, dbad
	lw	$t0, 4($t1)
	nop
	li	$t2, 0x454D4147
	bne	$t0, $t2, dbad
	lw	$t0, 8($t1)			# box colour (GS RGBA)
	nop
	sw	$t0, 0x44($s1)
	lw	$t0, 12($t1)			# level / start x
	nop
	sw	$t0, 0x48($s1)
	li	$t0, 1
	sw	$t0, 0x40($s1)
	j	ddone
dnext:	addu	$t1, $t1, $t2
	slt	$t0, $t1, $t9
	bnez	$t0, dr
dbad:	li	$t0, 3
	sw	$t0, 0x40($s1)
	j	ddone
dnone:	li	$t0, 2
	sw	$t0, 0x40($s1)
ddone:
	# ---- sound (SPU2 core 1 → DAC): upload a 2-block ADPCM square wave and play it on voice 0 (≈857 Hz, looping)
	li	$t0, 0xBF900400			# core 1 registers
	li	$t1, 0x8000			# ATTR: core on
	sh	$t1, 0x19A($t0)
	sh	$zero, 0x1A8($t0)		# TSA = 0x5000 (halfwords)
	li	$t1, 0x5000
	sh	$t1, 0x1AA($t0)
	li	$t3, 2				# two 16-byte blocks: +max (loop start), -max (loop end + repeat)
	li	$t4, 0x0404			# header: shift 4, filter 0 | flags 0x04 (loop start)
	li	$t5, 0x7777
sb1:	sh	$t4, 0x1AC($t0)
	li	$t2, 7
1:	sh	$t5, 0x1AC($t0)
	addiu	$t2, $t2, -1
	bnez	$t2, 1b
	li	$t4, 0x0304			# second block: flags 0x03 (end + repeat → jump to loop start)
	li	$t5, 0x9999
	addiu	$t3, $t3, -1
	bnez	$t3, sb1
	sh	$zero, 0x1C0($t0)		# voice 0 start address = 0x5000
	li	$t1, 0x5000
	sh	$t1, 0x1C2($t0)
	li	$t1, 0x3FFF			# VOLL / VOLR (fixed)
	sh	$t1, 0x000($t0)
	sh	$t1, 0x002($t0)
	li	$t1, 0x1000			# PITCH 1.0 (48 kHz)
	sh	$t1, 0x004($t0)
	li	$t1, 0x000F			# ADSR1: instant attack, sustain level max
	sh	$t1, 0x006($t0)
	li	$t1, 0x1FC0			# ADSR2: hold the sustain level
	sh	$t1, 0x008($t0)
	li	$t1, 1				# voice 0 → dry left / right
	sh	$t1, 0x188($t0)
	sh	$t1, 0x190($t0)
	li	$t1, 0x0C00			# MMIX: voices (dry) to the output
	sh	$t1, 0x198($t0)
	li	$t2, 0xBF900788			# core 1 master volume
	li	$t1, 0x3FFF
	sh	$t1, 0($t2)
	sh	$t1, 2($t2)
	li	$t1, 1				# key on voice 0
	sh	$t1, 0x1A0($t0)
	la	$a0, cfg_enter			# switch the controller to analog (DualShock) mode
	li	$a1, 5
	jal	xfer
	la	$a0, cfg_analog
	li	$a1, 9
	jal	xfer
	la	$a0, cfg_exit
	li	$a1, 9
	jal	xfer
	li	$s3, 0				# sequence
poll:	la	$a0, cmd_poll
	li	$a1, 9
	jal	xfer
	lbu	$t0, 2($s2)			# 0x5A when a controller answered
	nop
	li	$t1, 0x5A
	bne	$t0, $t1, idle
	lbu	$t0, 3($s2)			# buttons, active low
	nop
	lbu	$t1, 4($s2)
	nop
	sll	$t1, $t1, 8
	or	$t0, $t0, $t1
	nor	$t0, $t0, $zero
	andi	$t0, $t0, 0xFFFF
	lbu	$t1, 1($s2)			# mode (0x41 digital, 0x73 analog)
	nop
	sll	$t1, $t1, 16
	or	$t0, $t0, $t1
	addiu	$s3, $s3, 1
	sll	$t1, $s3, 24
	or	$t0, $t0, $t1
	sw	$t0, 0($s1)
	lbu	$t0, 5($s2)			# RX RY LX LY (0x80 = centre)
	nop
	lbu	$t1, 6($s2)
	nop
	sll	$t1, $t1, 8
	or	$t0, $t0, $t1
	lbu	$t1, 7($s2)
	nop
	sll	$t1, $t1, 16
	or	$t0, $t0, $t1
	lbu	$t1, 8($s2)
	nop
	sll	$t1, $t1, 24
	or	$t0, $t0, $t1
	sw	$t0, 4($s1)
	lw	$t0, 0x10($s1)			# save request from the EE: 'SAVE' x y score
	nop
	li	$t1, 0x53415645
	bne	$t0, $t1, idle
	la	$a0, mc_erase			# erase the block, then write the sector (flash semantics)
	li	$a1, 14
	jal	xfer
	la	$t4, mc_write
	li	$t7, 0xA0001200
	li	$t3, 31
4:	lbu	$t0, 0($t4)			# copy the command template to RAM
	nop
	sb	$t0, 0($t7)
	addiu	$t4, $t4, 1
	addiu	$t7, $t7, 1
	addiu	$t3, $t3, -1
	bnez	$t3, 4b
	li	$t7, 0xA0001200 + 13		# payload: 'MSH2' x y score, then XOR
	li	$t0, 0x3248534D
	li	$t8, 0				# xor
	li	$t5, 4				# 4 words
	li	$t9, 0xA0001010			# t9 → request words (word0 replaced by magic)
	li	$t6, 4
5:	beq	$t5, $t6, 6f
	lw	$t0, 0($t9)
	nop
6:	li	$t3, 4
7:	sb	$t0, 0($t7)
	xor	$t8, $t8, $t0
	andi	$t8, $t8, 0xFF
	srl	$t0, $t0, 8
	addiu	$t7, $t7, 1
	addiu	$t3, $t3, -1
	bnez	$t3, 7b
	addiu	$t9, $t9, 4
	addiu	$t5, $t5, -1
	bnez	$t5, 5b
	sb	$t8, 0($t7)
	li	$a0, 0xA0001200
	li	$a1, 31
	jal	xfer
	li	$t3, 32				# keep the card's answer for diagnostics (0x1180)
	move	$t4, $s2
	li	$t7, 0xA0001180
8:	lbu	$t0, 0($t4)
	nop
	sb	$t0, 0($t7)
	addiu	$t4, $t4, 1
	addiu	$t7, $t7, 1
	addiu	$t3, $t3, -1
	bnez	$t3, 8b
	li	$t0, 0x444F4E45			# 'DONE'
	sw	$t0, 0x10($s1)
	lw	$t0, 0x34($s1)
	nop
	addiu	$t0, $t0, 1
	sw	$t0, 0x34($s1)			# saves completed
idle:	li	$t0, 20000			# ~ a few hundred polls per second
1:	addiu	$t0, $t0, -1
	bnez	$t0, 1b
	j	poll

# readsec(a0 = LBA): one 2048-byte sector from the disc into IOP RAM 0x2000 via the CDVD "N" read command and DMA 3.
# Returns v0 = 1 when the data arrived (sentinel overwritten), 0 on timeout.
readsec:
	li	$t0, 0xA0002000
	li	$t1, 0x5A5AA5A5			# sentinel
	sw	$t1, 0($t0)
	li	$t0, 0xBF8010B0			# DMA3 (CDVD): MADR, BCR = 1 block of 512 words
	li	$t1, 0x2000
	sw	$t1, 0($t0)
	li	$t1, 0x00010200
	sw	$t1, 4($t0)
	li	$t0, 0xBF402005			# N-command parameters: LBA, count, retries, spindle, mode (2048)
	sb	$a0, 0($t0)
	srl	$t1, $a0, 8
	sb	$t1, 0($t0)
	srl	$t1, $a0, 16
	sb	$t1, 0($t0)
	srl	$t1, $a0, 24
	sb	$t1, 0($t0)
	li	$t1, 1
	sb	$t1, 0($t0)
	sb	$zero, 0($t0)
	sb	$zero, 0($t0)
	sb	$zero, 0($t0)
	sb	$zero, 0($t0)
	sb	$zero, 0($t0)
	sb	$zero, 0($t0)
	li	$t1, 6				# N_CD_READ
	sb	$t1, -1($t0)
	li	$t2, 3000000
	li	$t0, 0xA0002000
	li	$t3, 0x5A5AA5A5
1:	lw	$t1, 0($t0)
	nop
	bne	$t1, $t3, 2f
	addiu	$t2, $t2, -1
	bnez	$t2, 1b
	li	$v0, 0
	jr	$ra
2:	li	$t2, 200000			# let the command complete
3:	addiu	$t2, $t2, -1
	bnez	$t2, 3b
	li	$v0, 1
	jr	$ra

# xfer(a0 = command bytes, a1 = length): one SIO2 exchange on port 1, response into $s2
xfer:	li	$t0, 0x3BC			# send mode (reset the queue)
	sw	$t0, 0x68($s0)
	sll	$t1, $a1, 8
	sll	$t2, $a1, 18
	or	$t1, $t1, $t2
	ori	$t1, $t1, 0x40
	sw	$t1, 0x00($s0)			# SEND3[0]: port 1, lengths
	sw	$zero, 0x04($s0)
	move	$t3, $a1
	move	$t4, $a0
1:	lbu	$t5, 0($t4)
	nop
	sb	$t5, 0x60($s0)			# FIFO in
	addiu	$t4, $t4, 1
	addiu	$t3, $t3, -1
	bnez	$t3, 1b
	li	$t0, 0x3BD			# receive
	sw	$t0, 0x68($s0)
	move	$t3, $a1
	move	$t4, $s2
1:	lbu	$t5, 0x64($s0)			# FIFO out
	nop
	sb	$t5, 0($t4)
	addiu	$t4, $t4, 1
	addiu	$t3, $t3, -1
	bnez	$t3, 1b
	jr	$ra

gamedat:	.ascii "GAME.DAT;1"
cfg_enter:	.byte 0x01, 0x43, 0x00, 0x01, 0x00
cfg_analog:	.byte 0x01, 0x44, 0x00, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00
cfg_exit:	.byte 0x01, 0x43, 0x00, 0x00, 0x5A, 0x5A, 0x5A, 0x5A, 0x5A
cmd_poll:	.byte 0x01, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
# memory card, sector 0x2000 (block aligned): SET_SECTOR (10 bytes) followed by the operation, in one SIO2 transfer
mc_read:	.byte 0x81, 0x23, 0x00, 0x20, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00
		.byte 0x81, 0x43, 0x10, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x00, 0x00
mc_erase:	.byte 0x81, 0x21, 0x00, 0x20, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00
		.byte 0x81, 0x82, 0x00, 0x00
mc_write:	.byte 0x81, 0x22, 0x00, 0x20, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00
		.byte 0x81, 0x42, 0x10, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0x00, 0x00

