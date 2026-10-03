/**
 * Synthetic canonical taxonomy and product seeds. Original fictional data: no real merchant,
 * brand or product affiliation is implied.
 *
 * Line format (indentation = depth, two spaces per level):
 *   KEY | Name | Definition | synonym;synonym || Title ~ Brand ~ Size ~ Price ~ Description ;; ...
 * Lines with products are leaves. Products listed under a leaf have that leaf as their curated
 * expected concept.
 */
export const TAXONOMY_SOURCE = `
ROOT | All Products | Root of the canonical retail taxonomy.
  GRO | Grocery | Food products for preparation and consumption at home.
    GRO-DAI | Dairy & Eggs | Refrigerated dairy products, dairy alternatives and eggs.
      GRO-DAI-MILK | Dairy Milk | Fluid milk from cows, including whole, reduced fat, skim and lactose-free. | whole milk;2% milk;skim milk || Whole Milk ~ Meadow Lane ~ 1 gal ~ 4.29 ~ Grade A pasteurized whole milk. ;; 2% Reduced Fat Milk ~ Meadow Lane ~ 0.5 gal ~ 2.89 ;; Lactose Free Skim Milk ~ Clover Ridge ~ 64 fl oz ~ 4.99
      GRO-DAI-PLANT | Plant-Based Milk | Refrigerated or shelf-stable non-dairy milk beverages made from nuts, oats, soy or other plants. | almond milk;oat milk;soy milk;non-dairy milk || Unsweetened Almond Milk ~ Brightleaf ~ 64 fl oz ~ 3.79 ~ Almond beverage, no added sugar. ;; Barista Oat Milk ~ Brightleaf ~ 32 fl oz ~ 4.49 ;; Vanilla Soy Milk ~ Sunhollow ~ 64 fl oz ~ 3.59
      GRO-DAI-CHEESE | Cheese | Natural and processed cheese in blocks, slices, shreds or spreads. | cheddar;mozzarella || Sharp Cheddar Block ~ Meadow Lane ~ 8 oz ~ 3.99 ;; Shredded Mozzarella ~ Meadow Lane ~ 16 oz ~ 5.49 ;; Crumbled Feta ~ Tidewater ~ 6 oz ~ 4.29
      GRO-DAI-YOG | Yogurt | Cultured dairy and non-dairy yogurt, including Greek and drinkable styles. | greek yogurt || Plain Greek Yogurt ~ Clover Ridge ~ 32 oz ~ 5.99 ;; Strawberry Yogurt Cups 4 Pack ~ Clover Ridge ~ 4 x 5.3 oz ~ 3.99 ;; Coconut Yogurt Alternative Vanilla ~ Brightleaf ~ 5.3 oz ~ 1.99
      GRO-DAI-BUTTER | Butter & Margarine | Butter, margarine and plant-based buttery spreads. | butter || Salted Butter Sticks ~ Meadow Lane ~ 16 oz ~ 4.79 ;; Plant Butter Spread ~ Brightleaf ~ 13 oz ~ 4.99
      GRO-DAI-EGGS | Eggs | Shell eggs and liquid egg products. | eggs || Large Brown Eggs ~ Henhouse Row ~ 12 ct ~ 3.99 ;; Liquid Egg Whites ~ Henhouse Row ~ 16 oz ~ 3.49
    GRO-PRO | Produce | Fresh fruits, vegetables and herbs.
      GRO-PRO-FRUIT | Fresh Fruit | Whole or cut fresh fruit sold by weight, each or package. | apples;bananas;berries || Bananas ~ ~ per lb ~ 0.59 ~ Fresh yellow bananas. ;; Honeycrisp Apples ~ ~ 3 lb bag ~ 5.99 ~ Crisp, sweet eating apples. ;; Blueberries ~ Tidewater Farms ~ 1 pint ~ 3.99
      GRO-PRO-VEG | Fresh Vegetables | Whole or cut fresh vegetables, including salad greens. | lettuce;carrots || Baby Spinach ~ Tidewater Farms ~ 5 oz ~ 2.99 ;; Whole Carrots ~ ~ 2 lb bag ~ 1.99 ;; Roma Tomatoes ~ ~ per lb ~ 1.49
      GRO-PRO-HERB | Fresh Herbs | Fresh culinary herbs sold cut or potted. | basil;cilantro || Fresh Basil ~ Tidewater Farms ~ 0.75 oz ~ 2.49 ;; Cilantro Bunch ~ ~ 1 bunch ~ 0.99
    GRO-MEAT | Meat & Seafood | Fresh, frozen and packaged meat, poultry and seafood.
      GRO-MEAT-POULTRY | Poultry | Fresh or frozen raw chicken, turkey and other poultry. | chicken breast || Boneless Skinless Chicken Breast ~ Oaken Farms ~ per lb ~ 4.49 ;; Ground Turkey 93% Lean ~ Oaken Farms ~ 16 oz ~ 5.29
      GRO-MEAT-BEEF | Beef & Pork | Fresh or frozen raw beef, pork and lamb cuts and grinds. | ground beef || Ground Beef 85% Lean ~ Oaken Farms ~ 16 oz ~ 6.49 ;; Pork Loin Chops ~ Oaken Farms ~ per lb ~ 4.99
      GRO-MEAT-SEA | Seafood | Fresh, frozen or smoked fish and shellfish. | salmon;shrimp || Atlantic Salmon Fillet ~ Tidewater ~ per lb ~ 11.99 ;; Frozen Raw Shrimp Peeled ~ Tidewater ~ 12 oz ~ 8.99
      GRO-MEAT-DELI | Deli Meats | Sliced or packaged cooked and cured meats. | lunch meat || Oven Roasted Turkey Slices ~ Oaken Farms ~ 9 oz ~ 4.99 ;; Uncured Bacon ~ Oaken Farms ~ 12 oz ~ 6.99
    GRO-BAK | Bakery | Bread and baked goods.
      GRO-BAK-BREAD | Bread & Rolls | Sliced bread, rolls, bagels and tortillas. | sandwich bread || Whole Wheat Sandwich Bread ~ Kettlebrook ~ 20 oz ~ 3.49 ;; Everything Bagels 6 Count ~ Kettlebrook ~ 6 ct ~ 3.99 ;; Flour Tortillas ~ Sol Camino ~ 10 ct ~ 2.99
      GRO-BAK-SWEET | Sweet Baked Goods | Cakes, muffins, cookies and pastries from the bakery. | muffins;donuts || Blueberry Muffins 4 Count ~ Kettlebrook ~ 4 ct ~ 4.99 ;; Chocolate Chip Cookies Bakery Fresh ~ Kettlebrook ~ 12 ct ~ 4.49
    GRO-PAN | Pantry | Shelf-stable cooking and meal ingredients.
      GRO-PAN-PASTA | Pasta & Noodles | Dry or fresh pasta and noodles. | spaghetti;penne || Spaghetti ~ Nonna Vera ~ 16 oz ~ 1.79 ;; Gluten Free Penne ~ Nonna Vera ~ 12 oz ~ 3.29 ;; Ramen Noodle Soup Chicken Flavor ~ Quickbowl ~ 3 oz ~ 0.59
      GRO-PAN-RICE | Rice & Grains | Rice, quinoa, oats and other dry grains. | jasmine rice;quinoa || Jasmine Rice ~ Goldfield ~ 5 lb ~ 7.99 ;; Organic Quinoa ~ Goldfield ~ 16 oz ~ 5.49 ;; Old Fashioned Rolled Oats ~ Goldfield ~ 42 oz ~ 4.99
      GRO-PAN-CANVEG | Canned Vegetables & Beans | Canned or jarred vegetables, beans and tomatoes. | canned beans;canned tomatoes || Black Beans ~ Goldfield ~ 15 oz ~ 0.99 ;; Diced Tomatoes No Salt Added ~ Goldfield ~ 14.5 oz ~ 1.19 ;; Sweet Corn Kernels ~ Goldfield ~ 15.25 oz ~ 0.99
      GRO-PAN-COOKMILK | Canned Cooking Milks | Shelf-stable canned coconut milk, evaporated milk and condensed milk used as cooking ingredients. | canned coconut milk;evaporated milk;condensed milk || Coconut Milk Unsweetened Canned ~ Thai Lotus ~ 13.5 fl oz ~ 2.29 ~ Full fat coconut milk for curries and cooking. ;; Evaporated Milk ~ Goldfield ~ 12 fl oz ~ 1.49 ;; Sweetened Condensed Milk ~ Goldfield ~ 14 oz ~ 2.19
      GRO-PAN-SOUP | Soup & Broth | Canned, boxed or dry soups, broths and stocks. | chicken broth || Chicken Broth Low Sodium ~ Kettlebrook ~ 32 oz ~ 2.49 ;; Tomato Soup Condensed ~ Kettlebrook ~ 10.75 oz ~ 1.29
      GRO-PAN-OIL | Cooking Oils & Vinegars | Edible oils, cooking sprays and vinegars. | olive oil;vegetable oil || Extra Virgin Olive Oil ~ Nonna Vera ~ 16.9 fl oz ~ 8.99 ;; Canola Oil ~ Goldfield ~ 48 fl oz ~ 4.49 ;; Apple Cider Vinegar ~ Goldfield ~ 16 fl oz ~ 2.99 ~ Raw unfiltered vinegar made from apples.
      GRO-PAN-SAUCE | Sauces & Condiments | Pasta sauce, ketchup, mustard, mayonnaise, salsa and dressings. | ketchup;pasta sauce || Marinara Pasta Sauce ~ Nonna Vera ~ 24 oz ~ 3.49 ;; Tomato Ketchup ~ Redbarn ~ 20 oz ~ 2.99 ;; Medium Salsa ~ Sol Camino ~ 16 oz ~ 3.29
      GRO-PAN-BAKING | Baking Ingredients | Flour, sugar, baking mixes, leaveners and baking chips. | flour;sugar || All Purpose Flour ~ Goldfield ~ 5 lb ~ 3.49 ;; Granulated Sugar ~ Goldfield ~ 4 lb ~ 3.29 ;; Semi-Sweet Chocolate Chips ~ Kettlebrook ~ 12 oz ~ 3.49
      GRO-PAN-SPICE | Spices & Seasonings | Dried herbs, spices, salt and seasoning blends. | black pepper || Ground Black Pepper ~ Goldfield ~ 3 oz ~ 3.49 ;; Taco Seasoning Mix ~ Sol Camino ~ 1 oz ~ 0.99
      GRO-PAN-SPREAD | Nut Butters & Spreads | Peanut butter, other nut butters, jams and honey. | peanut butter;jam || Creamy Peanut Butter ~ Redbarn ~ 16 oz ~ 3.29 ;; Almond Butter ~ Brightleaf ~ 12 oz ~ 7.99 ~ Stone-ground roasted almonds. ;; Strawberry Preserves ~ Redbarn ~ 18 oz ~ 3.99
      GRO-PAN-NUTS | Nuts & Dried Fruit | Shelled or unshelled culinary and snacking nuts, seeds and dried fruit. | almonds;raisins || Whole Raw Almonds ~ Goldfield ~ 16 oz ~ 7.49 ;; Roasted Salted Cashews ~ Goldfield ~ 8 oz ~ 5.99 ;; Seedless Raisins ~ Goldfield ~ 12 oz ~ 3.29
    GRO-BRK | Breakfast | Breakfast cereals and breakfast foods.
      GRO-BRK-CEREAL | Cereal & Granola | Ready-to-eat cereals, granola and muesli. | cereal || Honey Oat Rings Cereal ~ Morning Lark ~ 12 oz ~ 3.99 ;; Almond Vanilla Granola ~ Morning Lark ~ 11 oz ~ 4.79 ~ Oat clusters with almonds.
      GRO-BRK-SYRUP | Pancake Mixes & Syrups | Pancake and waffle mixes and breakfast syrups. | maple syrup || Buttermilk Pancake Mix ~ Morning Lark ~ 32 oz ~ 3.49 ;; Pure Maple Syrup ~ Morning Lark ~ 12 fl oz ~ 8.99
    GRO-SNK | Snacks & Candy | Packaged snack foods and confectionery.
      GRO-SNK-CHIPS | Chips & Crackers | Potato chips, tortilla chips, pretzels, popcorn and crackers. | potato chips || Sea Salt Potato Chips ~ Crispwell ~ 8 oz ~ 3.49 ;; Tortilla Chips Restaurant Style ~ Sol Camino ~ 13 oz ~ 3.29 ;; Butter Crackers ~ Crispwell ~ 13.7 oz ~ 3.99
      GRO-SNK-BARS | Snack & Granola Bars | Granola, cereal, protein and fruit bars. | protein bar || Chewy Granola Bars Chocolate Chip ~ Morning Lark ~ 8 ct ~ 3.29 ;; Peanut Protein Bar ~ Peakline ~ 2.1 oz ~ 1.99
      GRO-SNK-CANDY | Candy & Chocolate | Chocolate, gummies, hard candy and gum. | chocolate bar || Milk Chocolate Bar ~ Velora ~ 3.5 oz ~ 2.49 ;; Fruit Gummy Bears ~ Velora ~ 5 oz ~ 1.99
      GRO-SNK-COOKIE | Packaged Cookies | Shelf-stable packaged cookies and snack cakes. | cookies || Chocolate Sandwich Cookies ~ Crispwell ~ 14.3 oz ~ 3.79 ;; Vanilla Wafers ~ Crispwell ~ 11 oz ~ 2.99
    GRO-FRZ | Frozen Foods | Foods stored and sold frozen.
      GRO-FRZ-MEAL | Frozen Meals & Pizza | Frozen entrees, pizza and prepared meals. | frozen pizza || Four Cheese Frozen Pizza ~ Forno Uno ~ 22 oz ~ 6.49 ;; Chicken Alfredo Frozen Entree ~ Forno Uno ~ 10 oz ~ 3.49
      GRO-FRZ-VEG | Frozen Fruits & Vegetables | Plain frozen vegetables and fruit. | frozen peas || Frozen Broccoli Florets ~ Goldfield ~ 12 oz ~ 1.99 ;; Frozen Mixed Berries ~ Goldfield ~ 16 oz ~ 4.49
      GRO-FRZ-ICE | Ice Cream & Frozen Desserts | Ice cream, frozen yogurt, sorbet and novelties. | ice cream || Vanilla Bean Ice Cream ~ Velora ~ 1.5 qt ~ 5.49 ;; Fruit Ice Pops ~ Velora ~ 12 ct ~ 3.99
  BEV | Beverages | Drinks other than fluid dairy and plant-based milks.
    BEV-WATER | Water | Still, sparkling and flavored waters.
      BEV-WATER-STILL | Still Water | Plain bottled still water, including spring and purified. | bottled water || Spring Water 24 Pack ~ Nimbus ~ 24 x 16.9 fl oz ~ 4.99 ;; Purified Water Gallon ~ Nimbus ~ 1 gal ~ 1.49
      BEV-WATER-SPARK | Sparkling Water | Carbonated water and seltzer, unsweetened, plain or naturally flavored. | seltzer || Lime Sparkling Water 8 Pack ~ Nimbus ~ 8 x 12 fl oz ~ 3.99 ;; Plain Seltzer ~ Nimbus ~ 1 L ~ 0.99
      BEV-WATER-ENH | Enhanced & Flavored Water | Still water with added vitamins, electrolytes or flavors, sweetened or unsweetened. | electrolyte water || Electrolyte Water ~ Peakline ~ 1 L ~ 1.99 ;; Berry Flavored Water Zero Sugar ~ Nimbus ~ 20 fl oz ~ 1.49
    BEV-SOFT | Soft Drinks | Carbonated sweetened beverages and mixers.
      BEV-SOFT-SODA | Soda | Carbonated soft drinks, regular and diet. | cola;pop || Cola 12 Pack Cans ~ Fizzline ~ 12 x 12 fl oz ~ 6.99 ;; Diet Lemon Lime Soda ~ Fizzline ~ 2 L ~ 2.29 ;; Ginger Ale ~ Fizzline ~ 2 L ~ 2.29
    BEV-JUICE | Juice | Fruit and vegetable juices and juice drinks.
      BEV-JUICE-FRUIT | Fruit Juice | 100% fruit juices and nectars, refrigerated or shelf-stable. | orange juice;apple juice || Orange Juice No Pulp ~ Sunhollow ~ 52 fl oz ~ 4.49 ;; Apple Juice ~ Sunhollow ~ 64 fl oz ~ 3.29 ~ 100% juice from concentrate.
      BEV-JUICE-DRINK | Juice Drinks & Lemonade | Sweetened juice drinks, lemonade and fruit punch with less than 100% juice. | lemonade || Classic Lemonade ~ Sunhollow ~ 52 fl oz ~ 2.99 ;; Fruit Punch Juice Drink Pouches ~ Sunhollow ~ 10 ct ~ 3.49
      BEV-JUICE-COCO | Coconut Water & Coconut Beverages | Ready-to-drink coconut water and refrigerated coconut milk beverages meant for drinking. | coconut water || Pure Coconut Water ~ Thai Lotus ~ 33.8 fl oz ~ 4.29 ;; Coconut Milk Beverage Original ~ Brightleaf ~ 64 fl oz ~ 3.99 ~ Refrigerated coconut drink, a dairy milk alternative for cereal and drinking.
    BEV-HOT | Coffee & Tea | Coffee, tea and hot drink mixes.
      BEV-HOT-COFFEE | Coffee | Whole bean, ground, instant and single-serve coffee. | ground coffee;k-cups || Medium Roast Ground Coffee ~ Ember & Oak ~ 12 oz ~ 8.99 ;; Dark Roast Coffee Pods ~ Ember & Oak ~ 12 ct ~ 7.99 ;; Cold Brew Coffee Unsweetened ~ Ember & Oak ~ 32 fl oz ~ 4.99
      BEV-HOT-TEA | Tea | Bagged, loose leaf and ready-to-drink tea. | green tea;iced tea || Green Tea Bags ~ Stillwater Tea ~ 40 ct ~ 4.49 ;; Unsweetened Iced Tea ~ Stillwater Tea ~ 59 fl oz ~ 2.99
      BEV-HOT-COCOA | Hot Cocoa & Drink Mixes | Hot chocolate mixes and powdered drink mixes. | hot chocolate || Hot Cocoa Mix ~ Velora ~ 10 ct ~ 2.99
    BEV-SPORT | Sports & Energy Drinks | Sports, energy and protein drinks.
      BEV-SPORT-ENERGY | Energy Drinks | Caffeinated energy drinks and shots. | energy drink || Energy Drink Original ~ Voltedge ~ 16 fl oz ~ 2.79 ;; Sugar Free Energy Drink 4 Pack ~ Voltedge ~ 4 x 8.4 fl oz ~ 6.99
      BEV-SPORT-SPORTS | Sports Drinks | Electrolyte sports drinks for hydration during activity. | sports drink || Lemon Lime Sports Drink ~ Peakline ~ 28 fl oz ~ 1.79 ;; Fruit Punch Sports Drink 8 Pack ~ Peakline ~ 8 x 20 fl oz ~ 7.49
  HOU | Household | Supplies for cleaning and maintaining a home.
    HOU-CLEAN | Cleaning Supplies | Products for cleaning surfaces and dishes.
      HOU-CLEAN-DISH | Dish Soap & Dishwasher Detergent | Hand dishwashing liquid and automatic dishwasher detergents. | dish soap;dishwasher pods || Dish Soap Lemon ~ Glint ~ 24 fl oz ~ 2.99 ~ Grease-cutting liquid for hand washing dishes. ;; Dishwasher Detergent Pods ~ Glint ~ 42 ct ~ 11.99 ;; Dish Soap Free & Clear ~ Pine & Pebble ~ 16 fl oz ~ 3.49
      HOU-CLEAN-SURF | Surface Cleaners | All-purpose, glass, bathroom and kitchen surface cleaners and wipes. | all purpose cleaner;disinfecting wipes || All Purpose Cleaner Spray ~ Glint ~ 32 fl oz ~ 3.49 ;; Disinfecting Wipes ~ Glint ~ 75 ct ~ 4.99 ;; Glass Cleaner ~ Glint ~ 26 fl oz ~ 3.29
      HOU-CLEAN-TOOLS | Cleaning Tools | Sponges, brushes, mops, brooms and gloves. | sponges || Scrub Sponges 6 Pack ~ Glint ~ 6 ct ~ 3.99 ;; Microfiber Mop ~ Glint ~ 1 ct ~ 14.99
    HOU-LAUN | Laundry | Products for washing and caring for clothes.
      HOU-LAUN-DET | Laundry Detergent | Liquid, powder and pod laundry detergents. | laundry soap || Liquid Laundry Detergent Fresh Scent ~ Pine & Pebble ~ 92 fl oz ~ 11.99 ;; Laundry Detergent Pods ~ Pine & Pebble ~ 42 ct ~ 12.99
      HOU-LAUN-SOFT | Fabric Softeners & Stain Removers | Fabric softener, dryer sheets, bleach and stain treatments. | dryer sheets;bleach || Dryer Sheets Lavender ~ Pine & Pebble ~ 120 ct ~ 5.49 ;; Stain Remover Spray ~ Pine & Pebble ~ 22 fl oz ~ 3.99
    HOU-PAPER | Paper & Plastic | Disposable paper and plastic household goods.
      HOU-PAPER-TOWEL | Paper Towels & Napkins | Paper towels and paper napkins. | paper towels || Paper Towels 6 Double Rolls ~ Lumo ~ 6 ct ~ 8.99 ;; Paper Napkins ~ Lumo ~ 200 ct ~ 2.99
      HOU-PAPER-TP | Toilet Paper | Bath tissue. | bath tissue || Toilet Paper 12 Mega Rolls ~ Lumo ~ 12 ct ~ 13.99 ;; Recycled Toilet Paper ~ Lumo ~ 6 ct ~ 5.99
      HOU-PAPER-TISSUE | Facial Tissue | Boxed and pocket facial tissues. | tissues || Facial Tissue Cube ~ Lumo ~ 3 x 60 ct ~ 4.49
      HOU-PAPER-BAGS | Trash & Storage Bags | Trash bags, food storage bags, foil and wraps. | garbage bags;zip bags || Tall Kitchen Trash Bags ~ Holdfast ~ 45 ct ~ 8.99 ;; Sandwich Zip Bags ~ Holdfast ~ 100 ct ~ 3.29 ;; Aluminum Foil ~ Holdfast ~ 75 sq ft ~ 4.49
    HOU-AIR | Air Care & Pest | Air fresheners, candles and pest control.
      HOU-AIR-FRESH | Air Fresheners & Candles | Room sprays, plug-ins and scented candles. | air freshener || Linen Air Freshener Spray ~ Glint ~ 8.8 oz ~ 3.29 ;; Vanilla Scented Candle ~ Hearthside ~ 7 oz ~ 6.99
      HOU-AIR-PEST | Pest Control | Insect sprays, traps and repellents for home use. | bug spray || Ant & Roach Killer Spray ~ Guardline ~ 17.5 oz ~ 5.49
  PC | Personal Care | Products for hygiene and grooming.
    PC-HAIR | Hair Care | Products for cleaning and styling hair.
      PC-HAIR-SHAMPOO | Shampoo & Conditioner | Shampoo, conditioner and 2-in-1 hair cleansers. | shampoo;conditioner || Moisturizing Shampoo ~ Purely ~ 12 fl oz ~ 4.99 ~ Daily shampoo for dry hair. ;; Volumizing Conditioner ~ Purely ~ 12 fl oz ~ 4.99 ;; Coconut Milk Shampoo ~ Purely ~ 13 fl oz ~ 6.49 ~ Shampoo with coconut milk extract for soft hair.
      PC-HAIR-STYLE | Hair Styling | Gels, sprays, mousse and styling creams. | hair gel;hairspray || Strong Hold Hair Gel ~ Purely ~ 8 oz ~ 3.99 ;; Flexible Hold Hairspray ~ Purely ~ 10 oz ~ 4.49
    PC-ORAL | Oral Care | Products for cleaning teeth and mouth.
      PC-ORAL-PASTE | Toothpaste | Toothpaste and tooth gels. | toothpaste || Whitening Toothpaste ~ Brightside ~ 4.8 oz ~ 3.49 ;; Kids Fluoride Toothpaste Bubble Fruit ~ Brightside ~ 4.2 oz ~ 2.99
      PC-ORAL-BRUSH | Toothbrushes & Floss | Manual and electric toothbrushes, floss and picks. | toothbrush;dental floss || Soft Toothbrush 2 Pack ~ Brightside ~ 2 ct ~ 3.99 ;; Mint Dental Floss ~ Brightside ~ 55 yd ~ 2.49
      PC-ORAL-RINSE | Mouthwash | Mouth rinses and breath sprays. | mouth rinse || Antiseptic Mouthwash Mint ~ Brightside ~ 33.8 fl oz ~ 5.99
    PC-BATH | Bath & Body | Products for washing and caring for skin.
      PC-BATH-SOAP | Body Wash & Bar Soap | Body wash, shower gel and bar soap. | body wash;bar soap || Body Wash Shea Butter ~ Purely ~ 18 fl oz ~ 5.49 ;; Bar Soap Sensitive Skin 6 Pack ~ Purely ~ 6 x 4 oz ~ 6.49
      PC-BATH-HAND | Hand Soap & Sanitizer | Liquid hand soap, refills and hand sanitizer. | hand soap;hand sanitizer || Liquid Hand Soap Lavender ~ Purely ~ 12 fl oz ~ 2.99 ;; Hand Sanitizer Gel ~ Purely ~ 8 fl oz ~ 2.99
      PC-BATH-LOTION | Lotion & Moisturizers | Body lotion, hand cream and facial moisturizers. | body lotion || Daily Body Lotion ~ Purely ~ 16 fl oz ~ 6.99 ;; Almond Oil Hand Cream ~ Purely ~ 3 oz ~ 4.49 ~ Hand cream scented with sweet almond.
      PC-BATH-DEO | Deodorant | Deodorants and antiperspirants. | antiperspirant || Antiperspirant Stick Fresh ~ Purely ~ 2.6 oz ~ 4.29 ;; Aluminum Free Deodorant ~ Purely ~ 2.7 oz ~ 5.99
      PC-BATH-SUN | Sun Care | Sunscreens and after-sun products. | sunscreen || Sunscreen Lotion SPF 50 ~ Solguard ~ 8 fl oz ~ 8.99
    PC-SHAVE | Shaving & Grooming | Razors, shaving cream and grooming tools.
      PC-SHAVE-RAZOR | Razors & Blades | Disposable razors, cartridges and handles. | razor || Disposable Razors 4 Pack ~ Keenedge ~ 4 ct ~ 5.99 ;; Shave Gel Sensitive ~ Keenedge ~ 7 oz ~ 3.49
    PC-FEM | Feminine Care | Menstrual and feminine hygiene products.
      PC-FEM-PADS | Pads & Tampons | Menstrual pads, liners and tampons. | tampons;pads || Regular Tampons ~ Luna Day ~ 36 ct ~ 7.99 ;; Ultra Thin Pads with Wings ~ Luna Day ~ 28 ct ~ 6.49
  OTC | OTC Health | Over-the-counter medicines, supplements and first aid. Classification only: no medical advice.
    OTC-PAIN | Pain & Fever | Over-the-counter pain relievers and fever reducers.
      OTC-PAIN-ORAL | Oral Pain Relievers | Tablets, capsules and liquids for pain or fever relief taken by mouth. | ibuprofen;acetaminophen || Ibuprofen Tablets 200 mg ~ Wellmark ~ 100 ct ~ 7.99 ;; Acetaminophen Extra Strength Caplets ~ Wellmark ~ 100 ct ~ 8.49
      OTC-PAIN-TOPICAL | Topical Pain Relief | Creams, gels and patches applied to skin for muscle or joint pain. | pain patch || Pain Relief Patch ~ Wellmark ~ 5 ct ~ 6.99 ;; Muscle Rub Cream ~ Wellmark ~ 3 oz ~ 5.99
    OTC-COLD | Cough, Cold & Allergy | Remedies for cold, cough, flu and allergy symptoms.
      OTC-COLD-ALLERGY | Allergy Relief | Antihistamine tablets, liquids and nasal sprays labeled for allergy relief. | antihistamine || 24 Hour Allergy Relief Tablets ~ Wellmark ~ 30 ct ~ 14.99 ~ Non-drowsy antihistamine tablets for allergy symptoms. ;; Children's Allergy Liquid ~ Wellmark ~ 4 fl oz ~ 7.99
      OTC-COLD-COUGH | Cough & Cold Remedies | Cough syrups, cold and flu multi-symptom medicines and lozenges. | cough syrup;cough drops || Daytime Cold & Flu Liquid ~ Wellmark ~ 12 fl oz ~ 9.99 ;; Honey Lemon Cough Drops ~ Wellmark ~ 30 ct ~ 2.49
    OTC-DIG | Digestive Health | Antacids, laxatives and digestive remedies.
      OTC-DIG-ANTACID | Antacids & Heartburn Relief | Antacids and acid reducers labeled for heartburn relief. | antacid || Antacid Chewable Tablets Berry ~ Wellmark ~ 96 ct ~ 5.49 ;; 24 Hour Acid Reducer Capsules ~ Wellmark ~ 14 ct ~ 9.99 ~ Capsules for frequent heartburn.
    OTC-VIT | Vitamins & Supplements | Dietary supplements in pill, gummy, powder or liquid form.
      OTC-VIT-MULTI | Multivitamins | Multivitamin and multimineral supplements. | multivitamin || Daily Multivitamin Tablets ~ Vitalroot ~ 100 ct ~ 9.99 ;; Kids Multivitamin Gummies ~ Vitalroot ~ 60 ct ~ 8.99
      OTC-VIT-SINGLE | Single Vitamins & Minerals | Individual vitamin and mineral supplements such as vitamin C, D or magnesium. | vitamin c;vitamin d || Vitamin C 500 mg Tablets ~ Vitalroot ~ 100 ct ~ 7.49 ;; Vitamin D3 2000 IU Softgels ~ Vitalroot ~ 120 ct ~ 8.99
      OTC-VIT-PROTEIN | Protein & Nutrition Powders | Protein powders and meal replacement powders. | protein powder || Whey Protein Powder Vanilla ~ Peakline ~ 2 lb ~ 24.99
    OTC-AID | First Aid | Bandages, antiseptics and first aid supplies.
      OTC-AID-BANDAGE | Bandages & Dressings | Adhesive bandages, gauze and medical tape. | band-aids || Flexible Fabric Bandages ~ Wellmark ~ 100 ct ~ 5.49 ;; Sterile Gauze Pads ~ Wellmark ~ 25 ct ~ 3.99
      OTC-AID-ANTISEPTIC | Antiseptics & Ointments | Hydrogen peroxide, rubbing alcohol and antibiotic ointments. | rubbing alcohol || Isopropyl Rubbing Alcohol 70% ~ Wellmark ~ 16 fl oz ~ 2.49 ;; Triple Antibiotic Ointment ~ Wellmark ~ 1 oz ~ 4.99
  PET | Pet | Food and supplies for household pets.
    PET-DOG | Dog | Products for dogs.
      PET-DOG-FOOD | Dog Food | Dry and wet complete food for dogs. | kibble || Adult Dry Dog Food Chicken & Rice ~ Tailwag ~ 15 lb ~ 24.99 ;; Wet Dog Food Beef Stew ~ Tailwag ~ 13 oz ~ 1.99
      PET-DOG-TREAT | Dog Treats | Treats, chews and biscuits for dogs. | dog biscuits || Peanut Butter Dog Biscuits ~ Tailwag ~ 16 oz ~ 4.99 ~ Crunchy baked treats for dogs with peanut butter flavor. ;; Dental Chews for Dogs ~ Tailwag ~ 12 ct ~ 8.99
    PET-CAT | Cat | Products for cats.
      PET-CAT-FOOD | Cat Food | Dry and wet complete food for cats. | cat kibble || Indoor Dry Cat Food Salmon ~ Whiskerly ~ 7 lb ~ 15.99 ;; Wet Cat Food Variety Pack ~ Whiskerly ~ 12 x 3 oz ~ 9.49
      PET-CAT-LITTER | Cat Litter | Clumping and non-clumping litter for cats. | kitty litter || Clumping Cat Litter Unscented ~ Whiskerly ~ 20 lb ~ 11.99
      PET-CAT-TREAT | Cat Treats | Treats and catnip for cats. | catnip || Crunchy Cat Treats Chicken ~ Whiskerly ~ 2.1 oz ~ 1.99
    PET-SUP | Pet Supplies | Non-food supplies for pets.
      PET-SUP-TOYS | Pet Toys | Toys for dogs, cats and small animals. | dog toy || Rope Tug Dog Toy ~ Tailwag ~ 1 ct ~ 6.99 ;; Feather Wand Cat Toy ~ Whiskerly ~ 1 ct ~ 4.99
      PET-SUP-WASTE | Pet Waste & Cleanup | Waste bags, pads and pet stain cleaners. | poop bags || Dog Waste Bags ~ Tailwag ~ 120 ct ~ 5.49 ;; Puppy Training Pads ~ Tailwag ~ 50 ct ~ 14.99
  BABY | Baby | Products for infants and toddlers.
    BABY-DIAPER | Diapering | Diapers, wipes and diaper care.
      BABY-DIAPER-DIAPERS | Diapers & Training Pants | Disposable diapers and training pants. | nappies || Baby Diapers Size 3 ~ Tiny Sprout ~ 84 ct ~ 24.99 ;; Training Pants 3T-4T ~ Tiny Sprout ~ 22 ct ~ 10.99
      BABY-DIAPER-WIPES | Baby Wipes | Wipes for diaper changes and baby cleanup. | wet wipes || Sensitive Baby Wipes ~ Tiny Sprout ~ 3 x 72 ct ~ 6.99 ;; Fragrance Free Baby Wipes Travel Pack ~ Tiny Sprout ~ 16 ct ~ 1.49
      BABY-DIAPER-CREAM | Diaper Rash Care | Diaper rash creams and ointments. | diaper cream || Diaper Rash Cream ~ Tiny Sprout ~ 4 oz ~ 6.49
    BABY-FEED | Baby Feeding | Formula, baby food and feeding supplies.
      BABY-FEED-FORMULA | Infant Formula | Powder, concentrate and ready-to-feed infant formula. | baby formula || Infant Formula Powder with Iron ~ Tiny Sprout ~ 20.5 oz ~ 26.99 ;; Sensitive Infant Formula Ready to Feed ~ Tiny Sprout ~ 32 fl oz ~ 9.99
      BABY-FEED-FOOD | Baby Food & Snacks | Purees, pouches, cereals and snacks formulated for babies and toddlers. | baby puree || Apple Banana Baby Food Pouch ~ Tiny Sprout ~ 3.5 oz ~ 1.39 ~ Stage 2 fruit puree for babies. ;; Baby Oatmeal Cereal ~ Tiny Sprout ~ 8 oz ~ 2.99 ;; Toddler Yogurt Melts Strawberry ~ Tiny Sprout ~ 1 oz ~ 3.49
      BABY-FEED-BOTTLE | Bottles & Feeding Supplies | Baby bottles, nipples, sippy cups and bibs. | baby bottle || Anti-Colic Baby Bottles 3 Pack ~ Cubby ~ 3 x 8 oz ~ 14.99 ;; Spill-Proof Sippy Cup ~ Cubby ~ 1 ct ~ 5.99
    BABY-CARE | Baby Bath & Skin Care | Baby wash, shampoo, lotion and oil.
      BABY-CARE-WASH | Baby Wash & Shampoo | Gentle washes and shampoos formulated for babies. | baby shampoo || Tear Free Baby Shampoo ~ Tiny Sprout ~ 13.6 fl oz ~ 4.99 ;; Baby Wash & Shampoo Fragrance Free ~ Tiny Sprout ~ 8 fl oz ~ 4.49
      BABY-CARE-LOTION | Baby Lotion & Oil | Lotions, oils and creams formulated for baby skin. | baby oil || Baby Lotion ~ Tiny Sprout ~ 13.6 fl oz ~ 5.49
  GM | General Merchandise | Non-consumable goods for home, office and leisure.
    GM-KIT | Kitchen & Dining | Cookware, tools and tableware.
      GM-KIT-COOK | Cookware & Bakeware | Pots, pans and baking dishes. | frying pan || Nonstick Frying Pan 10 Inch ~ Hearthside ~ 1 ct ~ 19.99 ;; Glass Baking Dish ~ Hearthside ~ 3 qt ~ 12.99
      GM-KIT-TOOLS | Kitchen Tools & Storage | Utensils, gadgets and reusable food storage containers. | food containers || Food Storage Containers 10 Piece ~ Holdfast ~ 10 pc ~ 9.99 ;; Stainless Steel Whisk ~ Hearthside ~ 1 ct ~ 5.99 ;; Apple Corer and Slicer ~ Hearthside ~ 1 ct ~ 7.99 ~ Stainless steel kitchen tool that cores and slices apples.
      GM-KIT-DISPOSABLE | Disposable Tableware | Paper plates, plastic cups and disposable cutlery. | paper plates || Paper Plates 9 Inch ~ Lumo ~ 100 ct ~ 6.99 ;; Plastic Cups 18 oz ~ Lumo ~ 50 ct ~ 5.49
    GM-ELEC | Electronics & Batteries | Batteries, cables and small electronics.
      GM-ELEC-BATT | Batteries | Household disposable and rechargeable batteries. | aa batteries || AA Alkaline Batteries 8 Pack ~ Voltcell ~ 8 ct ~ 7.99 ;; AAA Alkaline Batteries 8 Pack ~ Voltcell ~ 8 ct ~ 7.99
      GM-ELEC-ACC | Phone & Device Accessories | Charging cables, chargers, earbuds and cases. | charging cable;phone charger || USB-C Charging Cable 6 ft ~ Linkwire ~ 1 ct ~ 9.99 ;; Wired Earbuds ~ Linkwire ~ 1 ct ~ 12.99 ;; Fast Wall Charger 20W ~ Linkwire ~ 1 ct ~ 14.99
    GM-OFF | Office & School | Stationery and school supplies.
      GM-OFF-WRITE | Pens, Pencils & Markers | Writing instruments. | pens || Ballpoint Pens Black 10 Pack ~ Inkwell ~ 10 ct ~ 3.99 ;; No. 2 Pencils 12 Pack ~ Inkwell ~ 12 ct ~ 2.49
      GM-OFF-PAPER | Notebooks & Paper | Notebooks, printer paper and sticky notes. | notebook || Spiral Notebook College Ruled ~ Inkwell ~ 70 sheets ~ 1.99 ;; Copy Paper ~ Inkwell ~ 500 sheets ~ 6.99
    GM-HOME | Home & Hardware | Light bulbs, basic tools and home goods.
      GM-HOME-LIGHT | Light Bulbs | LED and other household light bulbs. | led bulb || LED Light Bulbs 60W Equivalent 4 Pack ~ Fixwell ~ 4 ct ~ 8.99
      GM-HOME-TOOLS | Hardware & Tools | Hand tools, tape, adhesives and fasteners. | duct tape || Duct Tape ~ Fixwell ~ 20 yd ~ 4.99 ;; Super Glue ~ Fixwell ~ 2 ct ~ 3.49
    GM-SEAS | Seasonal & Party | Party supplies, gift wrap and seasonal goods.
      GM-SEAS-PARTY | Party Supplies & Gift Wrap | Balloons, candles, gift bags and wrapping paper. | balloons || Birthday Candles ~ Hearthside ~ 24 ct ~ 1.99 ;; Assorted Latex Balloons ~ Hearthside ~ 25 ct ~ 3.49
      GM-SEAS-CARDS | Greeting Cards | Greeting cards for occasions. | birthday card || Birthday Greeting Card ~ Inkwell ~ 1 ct ~ 3.99
`;
