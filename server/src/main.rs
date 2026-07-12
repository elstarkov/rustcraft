mod world;

use world::World;

fn main() {
    // Temporary smoke test until the network layer lands:
    // generate a few chunks and report what's in them.
    let mut w = World::new(1337);
    let mut counts = [0usize; 10];
    for cz in -2..=2 {
        for cx in -2..=2 {
            let chunk = w.chunk(cx, cz);
            for &b in &chunk.blocks {
                counts[b as usize] += 1;
            }
        }
    }
    let names = [
        "air", "grass", "dirt", "stone", "sand", "log", "leaves", "planks", "glass", "water",
    ];
    println!("generated 25 chunks around origin:");
    for (name, count) in names.iter().zip(counts) {
        if count > 0 {
            println!("  {name:>6}: {count}");
        }
    }
    println!("spawn point: {:?}", w.spawn_point());
}
